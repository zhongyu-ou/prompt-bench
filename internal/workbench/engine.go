package workbench

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

var errActive = errors.New("another batch is active; stop it and wait for in-flight calls to finish before starting or replaying")

type activeBatch struct {
	detail   Detail
	next     int
	keys     map[string]string
	requests map[[2]string]FrozenRequest
	stopped  bool
}
type Engine struct {
	mu      sync.Mutex
	store   *Store
	client  *http.Client
	getenv  func(string) string
	active  *activeBatch
	wg      sync.WaitGroup
	fatal   error
	closing bool
}

func newEngine(s *Store, getenv func(string) string) *Engine {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = 20
	return &Engine{store: s, getenv: getenv, client: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func (e *Engine) start(name string, snapshot Snapshot, concurrency int, replayOf string, expectedVersion int64) (Batch, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.fatal != nil {
		return Batch{}, fmt.Errorf("persistence failure; restart server: %w", e.fatal)
	}
	if e.closing {
		return Batch{}, errors.New("server is shutting down")
	}
	if e.active != nil {
		return Batch{}, errActive
	}
	e.store.mu.Lock()
	defer e.store.mu.Unlock()
	if expectedVersion != 0 {
		st, err := e.store.state()
		if err != nil {
			return Batch{}, err
		}
		if st.Version != expectedVersion {
			return Batch{}, errStale
		}
	}
	keys := map[string]string{}
	for i := range snapshot.Requests {
		f := &snapshot.Requests[i]
		if _, err := lookupProtocol(f.Protocol); err != nil {
			return Batch{}, err
		}
		if err := validateFrozenHeaders(f.Headers); err != nil {
			return Batch{}, err
		}
		if f.CredentialRef == "" {
			return Batch{}, errors.New("snapshot credential reference is missing")
		}
		key, ok := keys[f.CredentialRef]
		if !ok {
			var err error
			key, _, err = e.store.credential(f.CredentialRef, f.APIKeyEnv, f.RequiresAuth, e.getenv)
			if err != nil {
				return Batch{}, err
			}
			keys[f.CredentialRef] = key
		}
		f.RequiresAuth = f.RequiresAuth || key != ""
	}
	if strings.TrimSpace(name) == "" {
		name = "Comparison"
	}
	d := Detail{Batch: Batch{ID: newID(), Name: name, Status: "running", CreatedAt: now(), Concurrency: concurrency, ReplayOf: replayOf}, Snapshot: snapshot, Results: []Result{}}
	maxRuns := 0
	rawRequests := make(map[[2]string]string, len(snapshot.Requests))
	total := 0
	for _, f := range snapshot.Requests {
		rawRequests[[2]string{f.CaseID, f.GroupID}] = f.RawRequest
		total += f.Runs
		if f.Runs > maxRuns {
			maxRuns = f.Runs
		}
	}
	d.Results = make([]Result, 0, total)
	for iteration := 1; iteration <= maxRuns; iteration++ {
		for _, f := range snapshot.Requests {
			if iteration > f.Runs {
				continue
			}
			d.Results = append(d.Results, Result{ID: newID(), CaseID: f.CaseID, CaseName: f.CaseName, GroupID: f.GroupID, GroupName: f.GroupName, Iteration: iteration, Status: "pending", Model: f.Model, Request: f.Request, RawRequest: rawRequests[[2]string{f.CaseID, f.GroupID}], PromptHash: f.PromptHash})
		}
	}
	d.Batch.Total = len(d.Results)
	if d.Batch.Total == 0 {
		return Batch{}, errors.New("snapshot has no requests")
	}
	if err := e.store.create(d); err != nil {
		return Batch{}, err
	}
	a := &activeBatch{detail: d, keys: keys, requests: make(map[[2]string]FrozenRequest, len(snapshot.Requests))}
	for _, f := range snapshot.Requests {
		a.requests[[2]string{f.CaseID, f.GroupID}] = f
	}
	e.active = a
	for range concurrency {
		e.wg.Add(1)
		go e.worker(a)
	}
	return d.Batch, nil
}
func (e *Engine) worker(a *activeBatch) {
	defer e.wg.Done()
	for {
		e.mu.Lock()
		if e.active != a || a.stopped || e.fatal != nil || a.next >= len(a.detail.Results) {
			e.mu.Unlock()
			return
		}
		idx := a.next
		a.next++
		r := a.detail.Results[idx]
		r.Status = "running"
		r.StartedAt = now()
		a.detail.Results[idx] = r
		a.detail.Batch.InFlight++
		if err := e.store.update(a.detail.Batch, r); err != nil {
			e.fatal = err
			e.mu.Unlock()
			return
		}
		f := a.requests[[2]string{r.CaseID, r.GroupID}]
		key := a.keys[f.CredentialRef]
		timeout := a.detail.Snapshot.TimeoutSeconds
		e.mu.Unlock()
		r = e.call(r, f, key, timeout)
		e.mu.Lock()
		a.detail.Batch.InFlight--
		if r.Status == "completed" {
			a.detail.Batch.Completed++
		} else {
			a.detail.Batch.Failed++
		}
		e.finish(a)
		if err := e.store.update(a.detail.Batch, r); err != nil {
			e.fatal = err
		}
		// Completed payloads live in SQLite, not a second in-memory history.
		a.detail.Results[idx] = Result{}
		if a.detail.Batch.InFlight == 0 && a.detail.Batch.FinishedAt != "" {
			e.active = nil
		}
		e.mu.Unlock()
	}
}
func (e *Engine) finish(a *activeBatch) {
	b := &a.detail.Batch
	if b.Completed+b.Failed+b.Cancelled == b.Total && b.InFlight == 0 {
		b.FinishedAt = now()
		switch {
		case a.stopped:
			b.Status = "stopped"
		case b.Failed > 0:
			b.Status = "completed_with_errors"
		default:
			b.Status = "completed"
		}
	}
}
func (e *Engine) stop(id string) (Batch, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.active == nil || e.active.detail.Batch.ID != id {
		d, err := e.store.detail(id)
		return d.Batch, err
	}
	a := e.active
	a.stopped = true
	a.detail.Batch.Status = "stopping"
	changed := []Result{}
	for i := a.next; i < len(a.detail.Results); i++ {
		r := a.detail.Results[i]
		r.Status = "cancelled"
		r.FinishedAt = now()
		r.Error = "stopped before dispatch"
		a.detail.Results[i] = r
		changed = append(changed, r)
		a.detail.Batch.Cancelled++
	}
	a.next = len(a.detail.Results)
	e.finish(a)
	if err := e.store.update(a.detail.Batch, changed...); err != nil {
		e.fatal = err
		return Batch{}, err
	}
	if a.detail.Batch.InFlight == 0 {
		e.active = nil
	}
	return a.detail.Batch, nil
}
func (e *Engine) detail(id string) (Detail, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.store.detail(id)
}
func (e *Engine) list() ([]Batch, error) { e.mu.Lock(); defer e.mu.Unlock(); return e.store.list() }
func (e *Engine) close() {
	e.mu.Lock()
	e.closing = true
	var id string
	if e.active != nil {
		id = e.active.detail.Batch.ID
	}
	e.mu.Unlock()
	if id != "" {
		e.stop(id)
	}
	e.wg.Wait()
	e.client.CloseIdleConnections()
}
func redact(s string, keys map[string]string) string {
	for _, key := range keys {
		if key == "" {
			continue
		}
		encoded, _ := json.Marshal(key)
		s = strings.ReplaceAll(s, string(encoded[1:len(encoded)-1]), "[REDACTED]")
		s = strings.ReplaceAll(s, key, "[REDACTED]")
	}
	return s
}

// JSON can echo a credential using arbitrary Unicode/slash escapes rather than
// its literal bytes. Re-encode only when that decoded content actually changes.
func redactBody(raw []byte, keys map[string]string) []byte {
	text := redact(string(raw), keys)
	if len(keys) > 0 && (strings.Contains(text, `\u`) || strings.Contains(text, `\/`)) {
		var value any
		decoder := json.NewDecoder(strings.NewReader(text))
		decoder.UseNumber()
		if decoder.Decode(&value) == nil && decoder.Decode(new(any)) == io.EOF {
			if clean, changed := redactJSON(value, keys); changed {
				encoded, err := json.Marshal(clean)
				if err == nil {
					return encoded
				}
			}
		}
	}
	return []byte(text)
}
func redactJSON(value any, keys map[string]string) (any, bool) {
	switch v := value.(type) {
	case string:
		clean := redact(v, keys)
		return clean, clean != v
	case []any:
		changed := false
		for i, item := range v {
			clean, different := redactJSON(item, keys)
			v[i] = clean
			changed = changed || different
		}
		return v, changed
	case map[string]any:
		clean := make(map[string]any, len(v))
		changed := false
		for k, item := range v {
			newKey := redact(k, keys)
			newValue, different := redactJSON(item, keys)
			clean[newKey] = newValue
			changed = changed || different || newKey != k
		}
		return clean, changed
	default:
		return value, false
	}
}
func (e *Engine) call(r Result, f FrozenRequest, key string, timeout int) Result {
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
	defer cancel()
	r.Status = "failed"
	adapter, err := lookupProtocol(f.Protocol)
	var req *http.Request
	if err == nil {
		req, err = http.NewRequestWithContext(ctx, f.Method, f.Endpoint, strings.NewReader(f.RawRequest))
	}
	if err == nil {
		for k, v := range f.Headers {
			req.Header.Set(k, v)
		}
		err = adapter.Authorize(req, key)
	}
	if err == nil {
		var resp *http.Response
		resp, err = e.client.Do(req)
		if resp != nil {
			r.HTTPStatus = resp.StatusCode
			raw, readErr := io.ReadAll(io.LimitReader(resp.Body, (16<<20)+1))
			resp.Body.Close()
			if len(raw) > 16<<20 {
				raw = raw[:16<<20]
				readErr = errors.New("response exceeds 16 MiB; preserved captured prefix")
			}
			raw = redactBody(raw, e.store.sensitiveValues())
			r.RawResponse = string(raw)
			if !utf8.Valid(raw) {
				r.RawResponseBase64 = base64.StdEncoding.EncodeToString(raw)
			}
			responseModel, output, decodeErr := adapter.Decode(raw)
			r.ResponseModel = responseModel
			switch {
			case err != nil:
			case readErr != nil:
				err = readErr
			case resp.StatusCode < 200 || resp.StatusCode >= 300:
				err = fmt.Errorf("upstream HTTP %d", resp.StatusCode)
			case decodeErr != nil:
				err = decodeErr
			default:
				r.Output = output
				r.Status = "completed"
			}
		}
	}
	if err != nil {
		r.Error = redact(err.Error(), e.store.sensitiveValues())
	}
	r.DurationMS = time.Since(start).Milliseconds()
	r.FinishedAt = now()
	return r
}
