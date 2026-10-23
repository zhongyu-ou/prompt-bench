package workbench

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
)

type evaluationInputError struct{ error }

func (e evaluationInputError) Unwrap() error { return e.error }

func evaluationStatus(err error) int {
	var input evaluationInputError
	switch {
	case errors.Is(err, errNotFound):
		return 404
	case errors.Is(err, errStale), errors.Is(err, errActive):
		return 409
	case errors.Is(err, errCredentialUnavailable):
		return 500
	case errors.As(err, &input):
		return 400
	default:
		return 500
	}
}

func evaluationFail(w http.ResponseWriter, err error) {
	status := evaluationStatus(err)
	if status == 500 {
		fail(w, status, errors.New("evaluation storage or execution failure; restart server"))
		return
	}
	fail(w, status, err)
}

func (a *API) evaluationAPI(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/api/evaluations" && !strings.HasPrefix(r.URL.Path, "/api/evaluations/") {
		return false
	}
	if r.URL.Path == "/api/evaluations" {
		switch r.Method {
		case "GET":
			list, err := a.store.evaluations()
			if err != nil {
				fail(w, 500, errors.New("could not read evaluations"))
			} else {
				sendJSON(w, 200, list)
			}
			return true
		case "POST":
			var in EvaluationInput
			if err := decode(w, r, &in); err != nil {
				fail(w, 400, err)
				return true
			}
			item, err := a.engine.startEvaluation(in)
			if err != nil {
				evaluationFail(w, err)
			} else {
				sendJSON(w, 202, item)
			}
			return true
		}
		fail(w, 405, errors.New("method not allowed"))
		return true
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/evaluations/"), "/")
	if len(parts) > 2 || !validID(parts[0]) {
		fail(w, 404, errNotFound)
		return true
	}
	id := parts[0]
	if r.Method == "GET" && (len(parts) == 1 || parts[1] == "export") {
		a.engine.mu.Lock()
		d, err := a.store.evaluationDetail(id)
		a.engine.mu.Unlock()
		if err != nil {
			evaluationFail(w, err)
			return true
		}
		if len(parts) == 2 {
			w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"promptbench-evaluation-%s.json\"", d.Evaluation.ID))
		}
		sendJSON(w, 200, d)
		return true
	}
	if r.Method == "POST" && len(parts) == 2 && (parts[1] == "stop" || parts[1] == "replay") {
		var body struct{}
		if err := decode(w, r, &body); err != nil {
			fail(w, 400, err)
			return true
		}
		var item Evaluation
		var err error
		status := 202
		if parts[1] == "stop" {
			item, err = a.engine.stopEvaluation(id)
			status = 200
		} else {
			item, err = a.engine.replayEvaluation(id)
		}
		if err != nil {
			evaluationFail(w, err)
		} else {
			sendJSON(w, status, item)
		}
		return true
	}
	fail(w, 404, errNotFound)
	return true
}
