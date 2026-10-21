package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type caseRead struct {
	Case
	VariablesJSON string `json:"variables_json"`
}

func (v StateView) MarshalJSON() ([]byte, error) {
	type plain StateView
	if v.Collections == nil {
		v.Collections = []Collection{}
	}
	cases := make([]caseRead, 0, len(v.State.Cases))
	for _, c := range v.State.Cases {
		raw, err := json.Marshal(c.Variables)
		if err != nil {
			return nil, err
		}
		cases = append(cases, caseRead{Case: c, VariablesJSON: string(raw)})
	}
	return json.Marshal(struct {
		plain
		Cases []caseRead `json:"cases"`
	}{plain(v), cases})
}
func caseVariables(existing map[string]any, variables map[string]any, raw *string, patch map[string]any, remove []string) (map[string]any, error) {
	if raw != nil && variables != nil {
		return nil, fmt.Errorf("use variables or variables_json, not both")
	}
	replacing := raw != nil || variables != nil
	if replacing && (patch != nil || len(remove) > 0) {
		return nil, fmt.Errorf("full variables replacement cannot be combined with variable_patch or remove_variables")
	}
	if raw != nil {
		d := json.NewDecoder(bytes.NewBufferString(*raw))
		d.UseNumber()
		if err := d.Decode(&variables); err != nil {
			return nil, fmt.Errorf("variables_json must contain one JSON object: %w", err)
		}
		var extra any
		if err := d.Decode(&extra); err != io.EOF {
			return nil, fmt.Errorf("variables_json must contain exactly one JSON object")
		}
	}
	if !replacing {
		if existing == nil {
			return nil, fmt.Errorf("new Case requires variables or variables_json")
		}
		variables = make(map[string]any, len(existing)+len(patch))
		for k, v := range existing {
			variables[k] = v
		}
		for _, k := range remove {
			if _, ok := patch[k]; ok {
				return nil, fmt.Errorf("variable %q cannot be patched and removed together", k)
			}
			delete(variables, k)
		}
		for k, v := range patch {
			variables[k] = v
		}
	}
	if err := validateVariables(variables); err != nil {
		return nil, err
	}
	return variables, nil
}
func validateVariables(v map[string]any) error {
	if v == nil {
		return fmt.Errorf("case variables must be an object")
	}
	if _, ok := v["TargetLanguageNameMap"]; ok {
		return fmt.Errorf("TargetLanguageNameMap belongs to group language_routes, not case variables")
	}
	if raw, ok := v["SourceLanguage"]; ok {
		if _, ok := raw.(string); !ok {
			return fmt.Errorf("SourceLanguage must be a string when present")
		}
	}
	return nil
}
func validateRoutes(routes []LanguageRoute) error {
	seen := map[string]bool{}
	for _, r := range routes {
		if !validID(r.SourceLanguage) || seen[r.SourceLanguage] {
			return fmt.Errorf("language routes require unique nonempty exact source_language values without surrounding whitespace")
		}
		seen[r.SourceLanguage] = true
		if len(r.Targets) == 0 {
			return fmt.Errorf("language route %q requires at least one target", r.SourceLanguage)
		}
		keys := map[string]bool{}
		for _, t := range r.Targets {
			if !validID(t.Key) || strings.TrimSpace(t.Name) == "" || strings.TrimSpace(t.Name) != t.Name || keys[t.Key] {
				return fmt.Errorf("language route %q requires unique nonempty target keys and names without surrounding whitespace", r.SourceLanguage)
			}
			keys[t.Key] = true
		}
	}
	return nil
}
func resolveLanguage(c Case, g Group) LanguageResolution {
	source, _ := c.Variables["SourceLanguage"].(string)
	for _, r := range g.LanguageRoutes {
		if r.SourceLanguage == source {
			return LanguageResolution{SourceLanguage: source, Targets: append([]Target{}, r.Targets...)}
		}
	}
	return LanguageResolution{SourceLanguage: source, Targets: []Target{{Key: "en", Name: "English"}}, UsedDefault: true}
}
func resolveSelection(st State, sel Selection) ([]string, error) {
	cases := map[string]bool{}
	collections := map[string]Collection{}
	for _, c := range st.Cases {
		cases[c.ID] = true
	}
	for _, c := range st.Collections {
		collections[c.ID] = c
	}
	seen := map[string]bool{}
	ids := []string{}
	add := func(id string) error {
		if !cases[id] {
			return fmt.Errorf("unknown case %q", id)
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
		return nil
	}
	for _, id := range sel.CaseIDs {
		if err := add(id); err != nil {
			return nil, err
		}
	}
	for _, id := range sel.CollectionIDs {
		c, ok := collections[id]
		if !ok {
			return nil, fmt.Errorf("unknown collection %q", id)
		}
		for _, cid := range c.CaseIDs {
			if err := add(cid); err != nil {
				return nil, err
			}
		}
	}
	excluded := map[string]bool{}
	for _, id := range sel.ExcludedCaseIDs {
		if !cases[id] {
			return nil, fmt.Errorf("unknown excluded case %q", id)
		}
		excluded[id] = true
	}
	out := []string{}
	for _, id := range ids {
		if !excluded[id] {
			out = append(out, id)
		}
	}
	return out, nil
}
func without(ids []string, id string) []string {
	out := []string{}
	for _, v := range ids {
		if v != id {
			out = append(out, v)
		}
	}
	return out
}
func hasID(ids []string, id string) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}
func (s *Store) mutateState(version int64, fn func(*State) error) (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.state()
	if err != nil {
		return st, err
	}
	if st.Version != version {
		return st, errStale
	}
	if err = fn(&st); err != nil {
		return st, err
	}
	return s.saveStateLocked(st, nil)
}
func (a *API) sendState(w http.ResponseWriter, status int, st State) {
	sendJSON(w, status, StateView{State: st, Credentials: a.store.credentialStatuses(st, a.engine.getenv)})
}
func (a *API) caseAPI(w http.ResponseWriter, r *http.Request) bool {
	path := r.URL.Path
	if path == "/api/cases/variables/preview" {
		if r.Method != "POST" {
			fail(w, 405, fmt.Errorf("method not allowed"))
			return true
		}
		var in struct {
			VariablesJSON   *string        `json:"variables_json"`
			VariablePatch   map[string]any `json:"variable_patch"`
			RemoveVariables []string       `json:"remove_variables"`
		}
		if err := decode(w, r, &in); err != nil {
			fail(w, 400, err)
			return true
		}
		if in.VariablesJSON == nil {
			fail(w, 400, fmt.Errorf("variables_json is required"))
			return true
		}
		base, err := caseVariables(nil, nil, in.VariablesJSON, nil, nil)
		if err != nil {
			fail(w, 400, err)
			return true
		}
		variables, err := caseVariables(base, nil, nil, in.VariablePatch, in.RemoveVariables)
		if err != nil {
			fail(w, 400, err)
			return true
		}
		raw, err := json.Marshal(variables)
		if err != nil {
			fail(w, 400, err)
			return true
		}
		sendJSON(w, 200, map[string]string{"variables_json": string(raw)})
		return true
	}
	if path == "/api/selection/preview" {
		if r.Method != "POST" {
			fail(w, 405, fmt.Errorf("method not allowed"))
			return true
		}
		var in struct {
			StateVersion int64 `json:"state_version"`
			Selection
			Groups []Group `json:"groups"`
		}
		if err := decode(w, r, &in); err != nil {
			fail(w, 400, err)
			return true
		}
		st, err := a.store.state()
		if err != nil {
			fail(w, 500, fmt.Errorf("could not read state"))
			return true
		}
		if st.Version != in.StateVersion {
			fail(w, 409, errStale)
			return true
		}
		ids, err := resolveSelection(st, in.Selection)
		if err != nil {
			fail(w, 400, err)
			return true
		}
		resolutions := []map[string]any{}
		count := 0
		seen := map[string]bool{}
		for _, g := range in.Groups {
			if seen[g.ID] {
				fail(w, 400, fmt.Errorf("duplicate group id"))
				return true
			}
			seen[g.ID] = true
			if !g.Enabled {
				continue
			}
			if err := validateGroup(g); err != nil {
				fail(w, 400, err)
				return true
			}
			count += len(ids) * g.Runs
			for _, id := range ids {
				for _, c := range st.Cases {
					if c.ID == id {
						v := resolveLanguage(c, g)
						resolutions = append(resolutions, map[string]any{"case_id": id, "group_id": g.ID, "source_language": v.SourceLanguage, "targets": v.Targets, "used_default": v.UsedDefault})
						break
					}
				}
			}
		}
		sendJSON(w, 200, map[string]any{"state_version": st.Version, "case_ids": ids, "case_count": len(ids), "request_count": count, "resolutions": resolutions})
		return true
	}
	isCase := path == "/api/cases" || strings.HasPrefix(path, "/api/cases/")
	isCollection := path == "/api/collections" || strings.HasPrefix(path, "/api/collections/")
	if !isCase && !isCollection {
		return false
	}
	var in struct {
		StateVersion    int64          `json:"state_version"`
		Variables       map[string]any `json:"variables"`
		VariablesJSON   *string        `json:"variables_json"`
		VariablePatch   map[string]any `json:"variable_patch"`
		RemoveVariables []string       `json:"remove_variables"`
		CollectionIDs   *[]string      `json:"collection_ids"`
		Name            *string        `json:"name"`
		Add             []string       `json:"add_case_ids"`
		Remove          []string       `json:"remove_case_ids"`
	}
	if err := decode(w, r, &in); err != nil {
		fail(w, 400, err)
		return true
	}
	prefix := "/api/cases"
	if isCollection {
		prefix = "/api/collections"
	}
	suffix := strings.TrimPrefix(path, prefix)
	parts := strings.Split(strings.TrimPrefix(suffix, "/"), "/")
	id := ""
	if suffix != "" {
		id = parts[0]
	}
	status := 200
	st, err := a.store.mutateState(in.StateVersion, func(st *State) error {
		if isCase {
			if in.Name != nil {
				return fmt.Errorf("Case has no name; use variables only")
			}
			if len(parts) > 1 {
				return errNotFound
			}
			idx := -1
			for i, c := range st.Cases {
				if c.ID == id {
					idx = i
					break
				}
			}
			switch r.Method {
			case "POST":
				if id != "" {
					return errNotFound
				}
				vars, err := caseVariables(nil, in.Variables, in.VariablesJSON, in.VariablePatch, in.RemoveVariables)
				if err != nil {
					return err
				}
				id = newID()
				st.Cases = append(st.Cases, Case{ID: id, Variables: vars})
				status = 201
			case "PUT":
				if idx < 0 {
					return errNotFound
				}
				vars, err := caseVariables(st.Cases[idx].Variables, in.Variables, in.VariablesJSON, in.VariablePatch, in.RemoveVariables)
				if err != nil {
					return err
				}
				st.Cases[idx].Variables = vars
			case "DELETE":
				if idx < 0 {
					return errNotFound
				}
				st.Cases = append(st.Cases[:idx], st.Cases[idx+1:]...)
				for i := range st.Collections {
					st.Collections[i].CaseIDs = without(st.Collections[i].CaseIDs, id)
				}
				st.Draft.CaseIDs = without(st.Draft.CaseIDs, id)
				st.Draft.ExcludedCaseIDs = without(st.Draft.ExcludedCaseIDs, id)
				return nil
			default:
				return fmt.Errorf("method not allowed")
			}
			if in.CollectionIDs != nil {
				known := map[string]bool{}
				for _, c := range st.Collections {
					known[c.ID] = true
				}
				for _, cid := range *in.CollectionIDs {
					if !known[cid] {
						return fmt.Errorf("unknown collection %q", cid)
					}
				}
				for i := range st.Collections {
					c := &st.Collections[i]
					c.CaseIDs = without(c.CaseIDs, id)
					if hasID(*in.CollectionIDs, c.ID) {
						c.CaseIDs = append(c.CaseIDs, id)
					}
				}
			}
			return nil
		}
		idx := -1
		for i, c := range st.Collections {
			if c.ID == id {
				idx = i
				break
			}
		}
		if len(parts) == 2 && parts[1] == "members" && r.Method == "POST" {
			if idx < 0 {
				return errNotFound
			}
			known := map[string]bool{}
			for _, c := range st.Cases {
				known[c.ID] = true
			}
			for _, cid := range append(append([]string{}, in.Add...), in.Remove...) {
				if !known[cid] {
					return fmt.Errorf("unknown case %q", cid)
				}
			}
			for _, cid := range in.Add {
				if hasID(in.Remove, cid) {
					return fmt.Errorf("case cannot be both added and removed")
				}
			}
			c := &st.Collections[idx]
			for _, cid := range in.Remove {
				c.CaseIDs = without(c.CaseIDs, cid)
			}
			for _, cid := range in.Add {
				if !hasID(c.CaseIDs, cid) {
					c.CaseIDs = append(c.CaseIDs, cid)
				}
			}
			return nil
		}
		if len(parts) > 1 {
			return errNotFound
		}
		switch r.Method {
		case "POST":
			if id != "" {
				return errNotFound
			}
			if in.Name == nil || strings.TrimSpace(*in.Name) == "" {
				return fmt.Errorf("collection name required")
			}
			st.Collections = append(st.Collections, Collection{ID: newID(), Name: *in.Name, CaseIDs: []string{}})
			status = 201
		case "PUT":
			if idx < 0 {
				return errNotFound
			}
			if in.Name == nil || strings.TrimSpace(*in.Name) == "" {
				return fmt.Errorf("collection name required")
			}
			st.Collections[idx].Name = *in.Name
		case "DELETE":
			if idx < 0 {
				return errNotFound
			}
			st.Collections = append(st.Collections[:idx], st.Collections[idx+1:]...)
			st.Draft.CollectionIDs = without(st.Draft.CollectionIDs, id)
		default:
			return fmt.Errorf("method not allowed")
		}
		return nil
	})
	if err != nil {
		fail(w, statusFor(err), err)
		return true
	}
	a.sendState(w, status, st)
	return true
}
