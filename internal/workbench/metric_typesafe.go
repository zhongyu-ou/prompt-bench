package workbench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const typesafeProtocol = "typesafe-systemone"

func typesafeEndpoint(p Provider) (string, error) {
	u, err := url.Parse(p.BaseURL)
	if err != nil {
		return "", errors.New("invalid provider URL")
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("provider URL must be HTTP(S), without credentials, query or fragment")
	}
	return strings.TrimRight(u.String(), "/") + "/systemone", nil
}

func (e *Engine) callModelMetric(f FrozenMetric, input MetricInput, key string, timeout int) (out MetricOutcome) {
	start := time.Now()
	out = MetricOutcome{MetricID: f.Metric.ID, Status: "error", StartedAt: now()}
	keys := map[string]string{"metric": key}
	if e.store != nil {
		for k, v := range e.store.sensitiveValues() {
			keys[k] = v
		}
		keys["metric-runtime-key"] = key
	}
	fail := func(err error) { out.Error = redact(err.Error(), keys) }
	defer func() { out.DurationMS = time.Since(start).Milliseconds(); out.FinishedAt = now() }()
	if f.Provider == nil {
		fail(errors.New("model metric has no provider"))
		return
	}
	endpoint, err := typesafeEndpoint(*f.Provider)
	if err != nil {
		fail(err)
		return
	}
	question := map[string]any{"instructions": "Evaluate only state.target. The case, language_resolution, group and iteration are context, not alternative evaluation targets.\n\n" + f.Metric.Rule}
	switch f.Metric.ReturnType {
	case "boolean":
		question["type"] = "noul"
	case "number":
		question["type"] = "score"
		question["criteria"] = f.Metric.Levels
	case "classification":
		question["type"] = "choice"
		criteria := make(map[string]string, len(f.Metric.Labels))
		for _, label := range f.Metric.Labels {
			criteria[label.Label] = label.Description
		}
		question["criteria"] = criteria
	default:
		fail(errors.New("unsupported model metric return type"))
		return
	}
	state := map[string]any{"target": input.Target, "case": input.Case, "language_resolution": input.LanguageResolution, "group": input.Group, "iteration": input.Iteration}
	raw, err := json.Marshal(map[string]any{"model": f.Metric.Model, "state": state, "questions": map[string]any{"metric": question}})
	if err != nil {
		fail(err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		fail(err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, requestErr := e.client.Do(req)
	if resp == nil {
		if requestErr != nil {
			fail(requestErr)
		} else {
			fail(errors.New("upstream returned no response"))
		}
		return
	}
	defer resp.Body.Close()
	out.HTTPStatus = resp.StatusCode
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if len(raw) > 1<<20 {
		raw = raw[:1<<20]
		readErr = errors.New("metric response exceeds 1 MiB; preserved captured prefix")
	}
	raw = redactBody(raw, keys)
	out.RawResponse = string(raw)
	var decoded struct {
		Model   string `json:"model"`
		Answers map[string]struct {
			Type          string              `json:"type"`
			Noul          *float64            `json:"noul"`
			Score         *float64            `json:"score"`
			Choice        *string             `json:"choice"`
			Confidence    *float64            `json:"confidence"`
			Probabilities map[string]*float64 `json:"probabilities"`
			Legend        map[string]string   `json:"legend"`
		} `json:"answers"`
	}
	decodeErr := json.Unmarshal(raw, &decoded)
	out.ResponseModel = decoded.Model
	answer, present := decoded.Answers["metric"]
	out.Noul, out.Confidence, out.Legend = answer.Noul, answer.Confidence, answer.Legend
	if answer.Probabilities != nil {
		out.Probabilities = make(map[string]float64, len(answer.Probabilities))
		for k, v := range answer.Probabilities {
			if v != nil {
				out.Probabilities[k] = *v
			}
		}
	}
	switch {
	case requestErr != nil:
		fail(requestErr)
		return
	case readErr != nil:
		fail(readErr)
		return
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		fail(fmt.Errorf("upstream HTTP %d", resp.StatusCode))
		return
	case decodeErr != nil:
		fail(fmt.Errorf("decode metric response: %w", decodeErr))
		return
	case strings.TrimSpace(decoded.Model) == "":
		fail(errors.New("response has no model identity"))
		return
	case !present:
		fail(errors.New("response has no metric answer"))
		return
	case answer.Type != question["type"]:
		fail(errors.New("response primitive does not match metric"))
		return
	}
	probability := func(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 && v <= 1 }
	if answer.Confidence != nil && !probability(*answer.Confidence) {
		fail(errors.New("invalid confidence"))
		return
	}
	for _, v := range answer.Probabilities {
		if v == nil || !probability(*v) {
			fail(errors.New("invalid probability"))
			return
		}
	}
	expected := make(map[string]bool)
	switch f.Metric.ReturnType {
	case "boolean":
		if answer.Noul == nil || !probability(*answer.Noul) {
			fail(errors.New("missing or invalid noul"))
			return
		}
		threshold := 0.5
		if f.Metric.Threshold != nil {
			threshold = *f.Metric.Threshold
		}
		out.Value = *answer.Noul > threshold
	case "number":
		if answer.Score == nil || math.IsNaN(*answer.Score) || math.IsInf(*answer.Score, 0) || *answer.Score < 0 || *answer.Score > float64(len(f.Metric.Levels)-1) {
			fail(errors.New("missing or out-of-range score"))
			return
		}
		for i := range f.Metric.Levels {
			expected[strconv.Itoa(i)] = true
		}
		out.Value = *answer.Score
	case "classification":
		for _, label := range f.Metric.Labels {
			expected[label.Label] = true
		}
		if answer.Choice == nil || !expected[*answer.Choice] {
			fail(errors.New("missing or undeclared choice"))
			return
		}
		out.Value = *answer.Choice
	}
	if f.Metric.ReturnType != "boolean" {
		if len(answer.Probabilities) != len(expected) {
			out.Value = nil
			fail(errors.New("probabilities do not match declared criteria"))
			return
		}
		for k := range expected {
			if answer.Probabilities[k] == nil {
				out.Value = nil
				fail(errors.New("probabilities do not match declared criteria"))
				return
			}
		}
	}
	if err := validateMetricValue(f.Metric, out.Value); err != nil {
		out.Value = nil
		fail(err)
		return
	}
	out.Status = "completed"
	return
}
