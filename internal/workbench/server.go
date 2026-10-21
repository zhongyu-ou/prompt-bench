package workbench

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"promptbench/web"
)

type API struct {
	store    *Store
	engine   *Engine
	host     string
	frontend http.Handler
}

func newAPI(s *Store, e *Engine, host string) *API {
	return &API{store: s, engine: e, host: host, frontend: http.FileServer(http.FS(web.Assets))}
}
func sendJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, err error) {
	sendJSON(w, status, map[string]string{"error": err.Error()})
}
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
	d := json.NewDecoder(r.Body)
	d.UseNumber()
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errors.New("body must contain exactly one JSON object")
	}
	return nil
}
func statusFor(err error) int {
	switch {
	case errors.Is(err, errNotFound):
		return 404
	case errors.Is(err, errStale) || errors.Is(err, errActive):
		return 409
	default:
		return 400
	}
}
func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	if !strings.EqualFold(r.Host, a.host) {
		fail(w, 403, errors.New("untrusted Host"))
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Scheme != "http" || !strings.EqualFold(u.Host, r.Host) || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			fail(w, 403, errors.New("untrusted Origin"))
			return
		}
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		ct := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]))
		if ct != "application/json" {
			fail(w, 415, errors.New("Content-Type must be application/json"))
			return
		}
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		if r.Method != "GET" && r.Method != "HEAD" {
			fail(w, 405, errors.New("method not allowed"))
			return
		}
		a.frontend.ServeHTTP(w, r)
		return
	}
	if a.packageAPI(w, r) || a.caseAPI(w, r) {
		return
	}
	switch r.URL.Path {
	case "/api/protocols":
		if r.Method != "GET" {
			break
		}
		sendJSON(w, 200, protocolCatalog())
		return
	case "/api/health":
		if r.Method != "GET" {
			break
		}
		sendJSON(w, 200, map[string]string{"status": "ok"})
		return
	case "/api/state":
		switch r.Method {
		case "GET":
			s, err := a.store.state()
			if err != nil {
				fail(w, 500, errors.New("could not read state"))
				return
			}
			sendJSON(w, 200, StateView{State: s, Credentials: a.store.credentialStatuses(s, a.engine.getenv)})
			return
		case "PUT":
			var raw json.RawMessage
			if err := decode(w, r, &raw); err != nil {
				fail(w, 400, errors.New("invalid state JSON"))
				return
			}
			var header struct {
				Version int64 `json:"version"`
			}
			if err := json.Unmarshal(raw, &header); err != nil {
				fail(w, 400, errors.New("invalid state JSON"))
				return
			}
			current, err := a.store.state()
			if err != nil {
				fail(w, 500, errors.New("could not read state"))
				return
			}
			if current.Version != header.Version {
				fail(w, 409, errStale)
				return
			}
			var input StateWrite
			d := json.NewDecoder(strings.NewReader(string(raw)))
			d.UseNumber()
			d.DisallowUnknownFields()
			if err := d.Decode(&input); err != nil {
				fail(w, 400, errors.New("invalid state JSON"))
				return
			}
			var fields map[string]json.RawMessage
			json.Unmarshal(raw, &fields)
			for key, pair := range map[string][2]any{"cases": {input.Cases, current.Cases}, "collections": {input.Collections, current.Collections}} {
				if _, present := fields[key]; present {
					if key == "cases" && len(input.Cases) == 0 && len(current.Cases) == 0 || key == "collections" && len(input.Collections) == 0 && len(current.Collections) == 0 {
						continue
					}
					supplied, _ := json.Marshal(pair[0])
					stored, _ := json.Marshal(pair[1])
					if !bytes.Equal(supplied, stored) {
						fail(w, 400, fmt.Errorf("%s is read-only in PUT /api/state; use dedicated Case/Collection endpoints", key))
						return
					}
				}
			}
			input.Cases = current.Cases
			input.Collections = current.Collections
			s, err := a.store.saveState(input.State, input.CredentialUpdates)
			if err != nil {
				fail(w, statusFor(err), err)
				return
			}
			sendJSON(w, 200, StateView{State: s, Credentials: a.store.credentialStatuses(s, a.engine.getenv)})
			return
		}
	case "/api/preview":
		if r.Method != "POST" {
			break
		}
		var in struct {
			StateVersion int64  `json:"state_version"`
			CaseID       string `json:"case_id"`
			Group        Group  `json:"group"`
		}
		if err := decode(w, r, &in); err != nil {
			fail(w, 400, err)
			return
		}
		s, err := a.store.state()
		if err != nil {
			fail(w, 500, errors.New("could not read state"))
			return
		}
		if in.StateVersion != s.Version {
			fail(w, 409, errStale)
			return
		}
		f, err := renderRequest(s, in.CaseID, in.Group)
		if err != nil {
			fail(w, 400, err)
			return
		}
		sendJSON(w, 200, map[string]any{"request": f.Request, "raw_request": f.RawRequest, "endpoint": f.Endpoint, "protocol": f.Protocol, "method": f.Method, "headers": f.Headers, "prompt_hash": f.PromptHash, "language_resolution": f.LanguageResolution})
		return
	case "/api/runs":
		switch r.Method {
		case "GET":
			b, err := a.engine.list()
			if err != nil {
				fail(w, 500, errors.New("could not read history"))
				return
			}
			sendJSON(w, 200, b)
			return
		case "POST":
			var in RunInput
			if err := decode(w, r, &in); err != nil {
				fail(w, 400, err)
				return
			}
			s, err := a.store.state()
			if err != nil {
				fail(w, 500, errors.New("could not read state"))
				return
			}
			if in.StateVersion != s.Version {
				fail(w, 409, errStale)
				return
			}
			snap, err := freeze(s, in)
			if err != nil {
				fail(w, 400, err)
				return
			}
			b, err := a.engine.start(in.Name, snap, in.Concurrency, "", in.StateVersion)
			if err != nil {
				fail(w, statusFor(err), err)
				return
			}
			sendJSON(w, 202, b)
			return
		}
	default:
		if strings.HasPrefix(r.URL.Path, "/api/runs/") {
			parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/runs/"), "/")
			if len(parts) > 2 || !validID(parts[0]) {
				fail(w, 404, errNotFound)
				return
			}
			id := parts[0]
			if len(parts) == 1 && r.Method == "GET" {
				d, err := a.engine.detail(id)
				if err != nil {
					fail(w, statusFor(err), err)
					return
				}
				sendJSON(w, 200, d)
				return
			}
			if len(parts) == 2 {
				switch parts[1] {
				case "export":
					if r.Method != "GET" {
						break
					}
					d, err := a.engine.detail(id)
					if err != nil {
						fail(w, statusFor(err), err)
						return
					}
					w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"promptbench-%s.json\"", d.Batch.ID))
					sendJSON(w, 200, d)
					return
				case "stop", "replay":
					if r.Method != "POST" {
						break
					}
					var body struct{}
					if err := decode(w, r, &body); err != nil {
						fail(w, 400, err)
						return
					}
					if parts[1] == "stop" {
						b, err := a.engine.stop(id)
						if err != nil {
							fail(w, statusFor(err), err)
							return
						}
						sendJSON(w, 200, b)
						return
					}
					d, err := a.engine.detail(id)
					if err != nil {
						fail(w, statusFor(err), err)
						return
					}
					b, err := a.engine.start(d.Batch.Name+" · replay", d.Snapshot, d.Batch.Concurrency, id, 0)
					if err != nil {
						fail(w, statusFor(err), err)
						return
					}
					sendJSON(w, 202, b)
					return
				}
			}
		}
		fail(w, 404, errNotFound)
		return
	}
	fail(w, 405, errors.New("method not allowed"))
}
