package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
)

type MetricLabel struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}
type Metric struct {
	ID         string        `json:"id"`
	Name       string        `json:"name"`
	Kind       string        `json:"kind"`
	ReturnType string        `json:"return_type"`
	Rule       string        `json:"rule"`
	Code       string        `json:"code,omitempty"`
	ProviderID string        `json:"provider_id,omitempty"`
	Model      string        `json:"model,omitempty"`
	Threshold  *float64      `json:"threshold,omitempty"`
	Levels     []string      `json:"levels,omitempty"`
	Labels     []MetricLabel `json:"labels,omitempty"`
}
type MetricTarget struct {
	Mode    string `json:"mode"`
	Pointer string `json:"pointer,omitempty"`
}
type MetricSelection struct {
	MetricID string       `json:"metric_id"`
	Target   MetricTarget `json:"target"`
}
type FrozenMetric struct {
	Metric       Metric       `json:"metric"`
	Target       MetricTarget `json:"target"`
	Provider     *Provider    `json:"provider,omitempty"`
	RequiresAuth bool         `json:"requires_auth,omitempty"`
}
type MetricGroup struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Model string `json:"model"`
}
type MetricInput struct {
	Case               SnapshotCase        `json:"case"`
	Output             string              `json:"output"`
	Target             any                 `json:"target"`
	LanguageResolution *LanguageResolution `json:"language_resolution,omitempty"`
	Group              MetricGroup         `json:"group"`
	Iteration          int                 `json:"iteration"`
}
type MetricOutcome struct {
	MetricID      string             `json:"metric_id"`
	Status        string             `json:"status"`
	Value         any                `json:"value,omitempty"`
	Reason        string             `json:"reason,omitempty"`
	Error         string             `json:"error,omitempty"`
	StartedAt     string             `json:"started_at,omitempty"`
	FinishedAt    string             `json:"finished_at,omitempty"`
	DurationMS    int64              `json:"duration_ms,omitempty"`
	ResponseModel string             `json:"response_model,omitempty"`
	RawResponse   string             `json:"raw_response,omitempty"`
	HTTPStatus    int                `json:"http_status,omitempty"`
	Noul          *float64           `json:"noul,omitempty"`
	Confidence    *float64           `json:"confidence,omitempty"`
	Probabilities map[string]float64 `json:"probabilities,omitempty"`
	Legend        map[string]string  `json:"legend,omitempty"`
}
type EvaluationProgress struct {
	Total       int `json:"total"`
	Pending     int `json:"pending"`
	Running     int `json:"running"`
	Completed   int `json:"completed"`
	Error       int `json:"error"`
	Skipped     int `json:"skipped"`
	Cancelled   int `json:"cancelled"`
	Interrupted int `json:"interrupted"`
}
type MetricSummary struct {
	MetricID    string         `json:"metric_id"`
	GroupID     string         `json:"group_id"`
	Valid       int            `json:"valid"`
	TrueCount   int            `json:"true_count"`
	FalseCount  int            `json:"false_count"`
	Mean        *float64       `json:"mean,omitempty"`
	Min         *float64       `json:"min,omitempty"`
	Max         *float64       `json:"max,omitempty"`
	Labels      map[string]int `json:"labels"`
	Error       int            `json:"error"`
	Skipped     int            `json:"skipped"`
	Cancelled   int            `json:"cancelled"`
	Interrupted int            `json:"interrupted"`
	Pending     int            `json:"pending"`
	Running     int            `json:"running"`
}

func validateMetric(m Metric) error {
	if !validID(m.ID) || strings.TrimSpace(m.Name) == "" {
		return errors.New("metric id and name required")
	}
	if len(m.Rule) > 64<<10 || len(m.Code) > 64<<10 {
		return errors.New("metric rule/code exceeds 64 KiB")
	}
	switch m.ReturnType {
	case "boolean", "number", "classification":
	default:
		return errors.New("metric return_type must be boolean, number or classification")
	}
	if m.Kind != "code" && m.Kind != "model" {
		return errors.New("metric kind must be code or model")
	}
	if m.Kind == "code" {
		if strings.TrimSpace(m.Code) == "" {
			return errors.New("code metric requires code")
		}
		if m.ProviderID != "" || m.Model != "" {
			return errors.New("code metric cannot reference a provider or model")
		}
	}
	if m.Kind == "model" {
		if m.Code != "" {
			return errors.New("model metric cannot contain code")
		}
		if m.ProviderID == "" || strings.TrimSpace(m.Model) == "" || strings.TrimSpace(m.Rule) == "" {
			return errors.New("model metric requires provider, model and rule")
		}
		if m.ReturnType == "number" {
			if len(m.Levels) < 2 || len(m.Levels) > 10 {
				return errors.New("model number metric requires 2–10 ordered level descriptions")
			}
			for _, l := range m.Levels {
				if strings.TrimSpace(l) == "" {
					return errors.New("level description required")
				}
			}
		}
	}
	if m.Threshold != nil && (m.ReturnType != "boolean" || m.Kind != "model" || math.IsNaN(*m.Threshold) || math.IsInf(*m.Threshold, 0) || *m.Threshold < 0 || *m.Threshold > 1) {
		return errors.New("threshold requires model boolean and a finite probability 0–1")
	}
	if m.ReturnType == "classification" {
		if len(m.Labels) < 2 || len(m.Labels) > 100 {
			return errors.New("classification metric requires 2–100 labels")
		}
		seen := map[string]bool{}
		for _, l := range m.Labels {
			if strings.TrimSpace(l.Label) == "" || seen[l.Label] || len(l.Label) > 256 || len(l.Description) > 64<<10 || m.Kind == "model" && strings.TrimSpace(l.Description) == "" {
				return errors.New("classification labels must be unique and model labels require descriptions")
			}
			seen[l.Label] = true
		}
	}
	return nil
}
func validateMetricValue(m Metric, v any) error {
	switch m.ReturnType {
	case "boolean":
		if _, ok := v.(bool); ok {
			return nil
		}
	case "number":
		if n, ok := v.(float64); ok && !math.IsNaN(n) && !math.IsInf(n, 0) {
			return nil
		}
		if n, ok := v.(json.Number); ok {
			f, e := n.Float64()
			if e == nil && !math.IsNaN(f) && !math.IsInf(f, 0) {
				return nil
			}
		}
	case "classification":
		if s, ok := v.(string); ok {
			for _, l := range m.Labels {
				if l.Label == s {
					return nil
				}
			}
		}
	}
	return errors.New("metric value does not match declared return type or labels")
}
func validateMetricTarget(t MetricTarget) error {
	if t.Mode == "output" {
		if t.Pointer != "" {
			return errors.New("whole-output target cannot have a pointer")
		}
		return nil
	}
	if t.Mode != "json_pointer" {
		return errors.New("target mode must be output or json_pointer")
	}
	if t.Pointer != "" && !strings.HasPrefix(t.Pointer, "/") {
		return errors.New("JSON Pointer must be empty or start with /")
	}
	for _, token := range strings.Split(t.Pointer, "/") {
		for i := 0; i < len(token); i++ {
			if token[i] == '~' {
				if i+1 >= len(token) || (token[i+1] != '0' && token[i+1] != '1') {
					return errors.New("invalid JSON Pointer escape")
				}
				i++
			}
		}
	}
	return nil
}
func metricTarget(output string, t MetricTarget) (any, error) {
	if err := validateMetricTarget(t); err != nil {
		return nil, err
	}
	if t.Mode == "output" {
		return output, nil
	}
	d := json.NewDecoder(strings.NewReader(output))
	d.UseNumber()
	var value any
	if err := d.Decode(&value); err != nil {
		return nil, fmt.Errorf("target JSON parse: %w", err)
	}
	if d.Decode(new(any)) != io.EOF {
		return nil, errors.New("target output must contain exactly one JSON value")
	}
	if t.Pointer == "" {
		return value, nil
	}
	for _, part := range strings.Split(t.Pointer[1:], "/") {
		part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
		switch v := value.(type) {
		case map[string]any:
			var ok bool
			value, ok = v[part]
			if !ok {
				return nil, errors.New("JSON Pointer field is missing")
			}
		case []any:
			if part == "" || len(part) > 1 && part[0] == '0' {
				return nil, errors.New("invalid JSON Pointer array index")
			}
			for _, c := range part {
				if c < '0' || c > '9' {
					return nil, errors.New("invalid JSON Pointer array index")
				}
			}
			n, err := strconv.Atoi(part)
			if err != nil || n < 0 || n >= len(v) {
				return nil, errors.New("JSON Pointer array index is missing")
			}
			value = v[n]
		default:
			return nil, errors.New("JSON Pointer traverses a scalar")
		}
	}
	return value, nil
}
func prepareMetricInput(input MetricInput, target MetricTarget) (MetricInput, error) {
	// Avoid parsing or copying an output already larger than the input ceiling.
	if len(input.Output) > metricInputMaxBytes {
		return input, errors.New("metric input exceeds 1 MiB")
	}
	value, err := metricTarget(input.Output, target)
	if err != nil {
		return input, err
	}
	input.Target = value
	raw, err := json.Marshal(input)
	if err != nil {
		return input, errors.New("metric input is not valid JSON")
	}
	if len(raw) > metricInputMaxBytes {
		return input, errors.New("metric input exceeds 1 MiB")
	}
	return input, nil
}

func freezeMetrics(s State, selections []MetricSelection) ([]FrozenMetric, error) {
	out := make([]FrozenMetric, 0, len(selections))
	seen := map[string]bool{}
	for _, sel := range selections {
		if seen[sel.MetricID] {
			return nil, errors.New("selected metric ids must be unique")
		}
		seen[sel.MetricID] = true
		if err := validateMetricTarget(sel.Target); err != nil {
			return nil, err
		}
		var metric *Metric
		for i := range s.Metrics {
			if s.Metrics[i].ID == sel.MetricID {
				metric = &s.Metrics[i]
				break
			}
		}
		if metric == nil {
			return nil, errors.New("selected metric does not exist")
		}
		if err := validateMetric(*metric); err != nil {
			return nil, err
		}
		f := FrozenMetric{Metric: *metric, Target: sel.Target}
		if metric.Kind == "model" {
			if metric.ReturnType == "boolean" && metric.Threshold == nil {
				threshold := 0.5
				f.Metric.Threshold = &threshold
			}
			for i := range s.Providers {
				if s.Providers[i].ID == metric.ProviderID {
					p := s.Providers[i]
					f.Provider = &p
					break
				}
			}
			if f.Provider == nil || f.Provider.Protocol != typesafeProtocol {
				return nil, errors.New("model metric requires a decision-capable provider")
			}
			f.RequiresAuth = true
		}
		out = append(out, f)
	}
	return out, nil
}
func evaluationSummary(d Detail) []MetricSummary {
	out := []MetricSummary{}
	indexes := map[[2]string]int{}
	for _, f := range d.Snapshot.Metrics {
		for _, groupID := range append([]string{""}, metricGroupIDs(d.Snapshot.Groups)...) {
			key := [2]string{f.Metric.ID, groupID}
			indexes[key] = len(out)
			labels := map[string]int{}
			for _, l := range f.Metric.Labels {
				labels[l.Label] = 0
			}
			out = append(out, MetricSummary{MetricID: f.Metric.ID, GroupID: groupID, Labels: labels})
		}
	}
	for _, r := range d.Results {
		groupIDs := []string{""}
		if r.GroupID != "" {
			groupIDs = append(groupIDs, r.GroupID)
		}
		for _, o := range r.Evaluations {
			for _, g := range groupIDs {
				i, ok := indexes[[2]string{o.MetricID, g}]
				if !ok {
					continue
				}
				s := &out[i]
				switch o.Status {
				case "completed":
					s.Valid++
					switch v := o.Value.(type) {
					case bool:
						if v {
							s.TrueCount++
						} else {
							s.FalseCount++
						}
					case float64:
						if s.Min == nil || v < *s.Min {
							x := v
							s.Min = &x
						}
						if s.Max == nil || v > *s.Max {
							x := v
							s.Max = &x
						}
						mean := v
						if s.Mean != nil {
							count := float64(s.Valid)
							previous := *s.Mean
							if math.Signbit(previous) == math.Signbit(v) {
								mean = previous + (v-previous)/count
							} else {
								// Opposite signs can overflow v-previous, while
								// same-sign sums can overflow a naive sum/count.
								mean = previous*(float64(s.Valid-1)/count) + v/count
							}
						}
						s.Mean = &mean
					case string:
						s.Labels[v]++
					}
				case "error":
					s.Error++
				case "skipped":
					s.Skipped++
				case "cancelled":
					s.Cancelled++
				case "interrupted":
					s.Interrupted++
				case "pending":
					s.Pending++
				case "running":
					s.Running++
				}
			}
		}
	}
	return out
}
func metricGroupIDs(groups []Group) []string {
	out := make([]string, 0, len(groups))
	for _, g := range groups {
		out = append(out, g.ID)
	}
	return out
}
