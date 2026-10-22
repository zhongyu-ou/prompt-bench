package workbench

import (
	"encoding/json"
	"errors"
	"net/http"
)

func (a *API) metricAPI(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/api/metrics/trial" {
		return false
	}
	if r.Method != "POST" {
		fail(w, 405, errors.New("method not allowed"))
		return true
	}
	var in struct {
		Metric Metric       `json:"metric"`
		Target MetricTarget `json:"target"`
		Input  MetricInput  `json:"input"`
	}
	if err := decode(w, r, &in); err != nil {
		fail(w, 400, err)
		return true
	}
	if in.Metric.Kind != "code" {
		fail(w, 400, errors.New("local trial accepts only code metrics"))
		return true
	}
	if err := validateMetric(in.Metric); err != nil {
		fail(w, 400, err)
		return true
	}
	if err := validateMetricTarget(in.Target); err != nil {
		fail(w, 400, err)
		return true
	}
	var out MetricOutcome
	input, err := prepareMetricInput(in.Input, in.Target)
	if err != nil {
		out = MetricOutcome{MetricID: in.Metric.ID, Status: "error", Error: err.Error(), FinishedAt: now()}
	} else {
		out = runCodeMetric(in.Metric, input)
	}
	raw, _ := json.Marshal(out)
	raw = redactBody(raw, a.store.sensitiveValues())
	json.Unmarshal(raw, &out)
	sendJSON(w, 200, out)
	return true
}
