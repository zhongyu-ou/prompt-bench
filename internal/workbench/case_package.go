package workbench

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
)

const casePackageFormat = "promptbench-cases"

type casePackage struct {
	Format      string       `json:"format"`
	Version     int          `json:"version"`
	Cases       []Case       `json:"cases"`
	Collections []Collection `json:"collections"`
}

type casePackageImportInput struct {
	StateVersion  int64    `json:"state_version"`
	Format        string   `json:"format"`
	Content       string   `json:"content"`
	CollectionIDs []string `json:"collection_ids,omitempty"`
}

type casePackagePreviewCase struct {
	FileID    string         `json:"file_id"`
	Status    string         `json:"status"`
	LocalID   string         `json:"local_id,omitempty"`
	Variables map[string]any `json:"variables"`
}

type casePackagePreview struct {
	StateVersion    int64                    `json:"state_version"`
	NewCount        int                      `json:"new_count"`
	ExistingCount   int                      `json:"existing_count"`
	Cases           []casePackagePreviewCase `json:"cases"`
	CollectionCount int                      `json:"collection_count"`
	Warnings        []string                 `json:"warnings"`
}

type casePackageImportPlan struct {
	Preview     casePackagePreview
	CaseIDMap   map[string]string
	NewCases    []Case
	Collections []Collection
}

// packageJSON decodes exactly one value without coercing JSON number lexemes.
func packageJSON(data []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	if err := d.Decode(out); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errors.New("expected exactly one JSON value")
	}
	return nil
}

// Package objects use exact field spelling, unlike encoding/json's struct matching.
func packageObject(data []byte, kind string, fields ...string) (map[string]json.RawMessage, error) {
	var object map[string]json.RawMessage
	if err := packageJSON(data, &object); err != nil || object == nil {
		return nil, fmt.Errorf("%s must be a JSON object", kind)
	}
	allowed := make(map[string]bool, len(fields))
	for _, field := range fields {
		allowed[field] = true
	}
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if !allowed[key] {
			if key == "name" || key == "description" {
				return nil, fmt.Errorf("%s: legacy field %q is unsupported; remove it and use only id and variables for Cases", kind, key)
			}
			return nil, fmt.Errorf("%s: unsupported field %q; allowed fields: %s", kind, key, strings.Join(fields, ", "))
		}
	}
	for _, field := range fields {
		if _, ok := object[field]; !ok {
			return nil, fmt.Errorf("%s: required field %q is missing", kind, field)
		}
	}
	return object, nil
}

func packageField(object map[string]json.RawMessage, field string, out any) error {
	if bytes.Equal(bytes.TrimSpace(object[field]), []byte("null")) {
		return fmt.Errorf("%s must not be null", field)
	}
	if err := packageJSON(object[field], out); err != nil {
		return fmt.Errorf("invalid %s: %w", field, err)
	}
	return nil
}

func parsePackageCase(data []byte, jsonl bool) (Case, error) {
	var c Case
	fields := []string{"id", "variables"}
	if jsonl {
		fields = append(fields, "type")
	}
	object, err := packageObject(data, "Case", fields...)
	if err != nil {
		return c, err
	}
	if err = packageField(object, "id", &c.ID); err != nil {
		return c, err
	}
	if !validID(c.ID) {
		return c, errors.New("Case id must be nonempty, at most 128 characters, and without surrounding whitespace")
	}
	if err = packageField(object, "variables", &c.Variables); err != nil {
		return c, err
	}
	if _, found := c.Variables["TargetLanguageNameMap"]; found {
		return c, errors.New("Case variables.TargetLanguageNameMap is execution-owned and unsupported in packages; remove it and configure group language_routes instead")
	}
	return c, nil
}

func parsePackageCollection(data []byte, jsonl bool) (Collection, error) {
	var c Collection
	fields := []string{"id", "name", "case_ids"}
	if jsonl {
		fields = append(fields, "type")
	}
	object, err := packageObject(data, "collection", fields...)
	if err != nil {
		return c, err
	}
	if err = packageField(object, "id", &c.ID); err != nil {
		return c, err
	}
	if !validID(c.ID) {
		return c, errors.New("collection id must be nonempty, at most 128 characters, and without surrounding whitespace")
	}
	if err = packageField(object, "name", &c.Name); err != nil {
		return c, err
	}
	if strings.TrimSpace(c.Name) == "" {
		return c, errors.New("collection name must not be blank")
	}
	if err = packageField(object, "case_ids", &c.CaseIDs); err != nil {
		return c, err
	}
	seen := map[string]bool{}
	for _, id := range c.CaseIDs {
		if !validID(id) || seen[id] {
			return c, errors.New("collection case_ids must contain unique, nonempty Case IDs without surrounding whitespace")
		}
		seen[id] = true
	}
	return c, nil
}

func parseCasePackage(format, content string) (casePackage, error) {
	p := casePackage{Format: casePackageFormat, Version: 1, Cases: []Case{}, Collections: []Collection{}}
	var cases, collections []json.RawMessage
	switch format {
	case "json":
		object, err := packageObject([]byte(content), "package", "format", "version", "cases", "collections")
		if err != nil {
			return p, fmt.Errorf("invalid standard JSON package: %w; use format %q version 1 (legacy packages are not supported)", err, casePackageFormat)
		}
		if err = validatePackageHeader(object); err != nil {
			return p, err
		}
		if err = packageField(object, "cases", &cases); err != nil {
			return p, err
		}
		if err = packageField(object, "collections", &collections); err != nil {
			return p, err
		}
		for i, raw := range cases {
			c, err := parsePackageCase(raw, false)
			if err != nil {
				return p, fmt.Errorf("cases[%d]: %w", i, err)
			}
			p.Cases = append(p.Cases, c)
		}
		for i, raw := range collections {
			c, err := parsePackageCollection(raw, false)
			if err != nil {
				return p, fmt.Errorf("collections[%d]: %w", i, err)
			}
			p.Collections = append(p.Collections, c)
		}
	case "jsonl":
		header := false
		for i, line := range strings.Split(content, "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			var record map[string]json.RawMessage
			if err := packageJSON([]byte(line), &record); err != nil || record == nil {
				return p, fmt.Errorf("JSONL line %d must contain one JSON object", i+1)
			}
			var kind string
			if err := packageField(record, "type", &kind); err != nil {
				return p, fmt.Errorf("JSONL line %d: %w; standard JSONL requires a package header and typed records", i+1, err)
			}
			if !header {
				if kind != "package" {
					return p, fmt.Errorf("JSONL line %d: first record must be a package header", i+1)
				}
				object, err := packageObject([]byte(line), "package header", "type", "format", "version")
				if err != nil {
					return p, fmt.Errorf("JSONL line %d: %w", i+1, err)
				}
				if err = validatePackageHeader(object); err != nil {
					return p, fmt.Errorf("JSONL line %d: %w", i+1, err)
				}
				header = true
				continue
			}
			switch kind {
			case "case":
				c, err := parsePackageCase([]byte(line), true)
				if err != nil {
					return p, fmt.Errorf("JSONL line %d: %w", i+1, err)
				}
				p.Cases = append(p.Cases, c)
			case "collection":
				c, err := parsePackageCollection([]byte(line), true)
				if err != nil {
					return p, fmt.Errorf("JSONL line %d: %w", i+1, err)
				}
				p.Collections = append(p.Collections, c)
			default:
				return p, fmt.Errorf("JSONL line %d: unsupported record type %q; expected case or collection", i+1, kind)
			}
		}
		if !header {
			return p, errors.New("JSONL package header is required")
		}
	default:
		return p, errors.New("format must be json or jsonl")
	}
	if err := validateCasePackage(p); err != nil {
		return p, err
	}
	return p, nil
}

func validatePackageHeader(object map[string]json.RawMessage) error {
	var format string
	var version int
	if err := packageField(object, "format", &format); err != nil {
		return err
	}
	if err := packageField(object, "version", &version); err != nil {
		return err
	}
	if format != casePackageFormat || version != 1 {
		return fmt.Errorf("unsupported package format/version; expected format %q and version 1", casePackageFormat)
	}
	return nil
}

// Marshal sorts object keys while preserving strings, array order, null and number lexemes.
func caseInputFingerprint(variables map[string]any) (string, error) {
	data, err := json.Marshal(variables)
	return string(data), err
}

func validateCasePackage(p casePackage) error {
	cases := make(map[string]string, len(p.Cases))
	for _, c := range p.Cases {
		fingerprint, err := caseInputFingerprint(c.Variables)
		if err != nil {
			return fmt.Errorf("Case %s: invalid variables: %w", c.ID, err)
		}
		if previous, found := cases[c.ID]; found && previous != fingerprint {
			return fmt.Errorf("duplicate file Case id %q has different variables; assign distinct file IDs", c.ID)
		}
		cases[c.ID] = fingerprint
	}
	collections := make(map[string]bool, len(p.Collections))
	for _, c := range p.Collections {
		if collections[c.ID] {
			return fmt.Errorf("duplicate collection id %q", c.ID)
		}
		collections[c.ID] = true
		for _, id := range c.CaseIDs {
			if _, found := cases[id]; !found {
				return fmt.Errorf("collection %q references unknown file Case id %q; include every referenced Case in the package", c.ID, id)
			}
		}
	}
	return nil
}

func planCasePackageImport(st State, p casePackage, targetIDs []string) (casePackageImportPlan, error) {
	plan := casePackageImportPlan{
		Preview:   casePackagePreview{StateVersion: st.Version, Cases: []casePackagePreviewCase{}, CollectionCount: len(p.Collections), Warnings: []string{}},
		CaseIDMap: map[string]string{}, NewCases: []Case{}, Collections: make([]Collection, len(st.Collections)),
	}
	if err := validateCasePackage(p); err != nil {
		return plan, err
	}
	collectionIndex := make(map[string]int, len(st.Collections))
	for i, c := range st.Collections {
		collectionIndex[c.ID] = i
		plan.Collections[i] = c
		plan.Collections[i].CaseIDs = append([]string{}, c.CaseIDs...)
	}
	for _, id := range targetIDs {
		if _, found := collectionIndex[id]; !found {
			return plan, fmt.Errorf("target collection %q does not exist", id)
		}
	}
	byInput := make(map[string]string, len(st.Cases))
	existingIDs := make(map[string]bool, len(st.Cases))
	for _, c := range st.Cases {
		fingerprint, err := caseInputFingerprint(c.Variables)
		if err != nil {
			return plan, err
		}
		if _, found := byInput[fingerprint]; !found {
			byInput[fingerprint] = c.ID
		}
		existingIDs[c.ID] = true
	}
	for _, c := range p.Cases {
		if _, found := plan.CaseIDMap[c.ID]; found {
			continue
		}
		fingerprint, err := caseInputFingerprint(c.Variables)
		if err != nil {
			return plan, err
		}
		localID, found := byInput[fingerprint]
		row := casePackagePreviewCase{FileID: c.ID, Variables: c.Variables, Status: "existing"}
		if found {
			plan.Preview.ExistingCount++
			if existingIDs[localID] {
				row.LocalID = localID
			}
		} else {
			for {
				localID = newID()
				if _, used := existingIDs[localID]; !used {
					break
				}
			}
			existingIDs[localID] = false
			byInput[fingerprint] = localID
			plan.NewCases = append(plan.NewCases, Case{ID: localID, Variables: c.Variables})
			plan.Preview.NewCount++
			row.Status = "new"
		}
		plan.CaseIDMap[c.ID] = localID
		plan.Preview.Cases = append(plan.Preview.Cases, row)
	}
	for _, imported := range p.Collections {
		i, found := collectionIndex[imported.ID]
		if !found {
			i = len(plan.Collections)
			collectionIndex[imported.ID] = i
			plan.Collections = append(plan.Collections, Collection{ID: imported.ID, Name: imported.Name, CaseIDs: []string{}})
		}
		for _, fileID := range imported.CaseIDs {
			plan.Collections[i].CaseIDs = appendPackageMember(plan.Collections[i].CaseIDs, plan.CaseIDMap[fileID])
		}
	}
	for _, id := range targetIDs {
		i := collectionIndex[id]
		for _, row := range plan.Preview.Cases {
			plan.Collections[i].CaseIDs = appendPackageMember(plan.Collections[i].CaseIDs, plan.CaseIDMap[row.FileID])
		}
	}
	return plan, nil
}

func appendPackageMember(ids []string, id string) []string {
	for _, existing := range ids {
		if existing == id {
			return ids
		}
	}
	return append(ids, id)
}

func exportCasePackage(st State, caseIDs, collectionIDs []string, includeMemberships bool) (casePackage, error) {
	p := casePackage{Format: casePackageFormat, Version: 1, Cases: []Case{}, Collections: []Collection{}}
	cases := make(map[string]Case, len(st.Cases))
	for _, c := range st.Cases {
		cases[c.ID] = c
	}
	collections := make(map[string]Collection, len(st.Collections))
	for _, c := range st.Collections {
		collections[c.ID] = c
	}
	seenCases := map[string]bool{}
	addCase := func(id string) error {
		c, found := cases[id]
		if !found {
			return fmt.Errorf("Case %q does not exist", id)
		}
		if !seenCases[id] {
			seenCases[id] = true
			p.Cases = append(p.Cases, c)
		}
		return nil
	}
	for _, id := range caseIDs {
		if err := addCase(id); err != nil {
			return p, err
		}
	}
	seenCollections := map[string]bool{}
	for _, id := range collectionIDs {
		c, found := collections[id]
		if !found {
			return p, fmt.Errorf("collection %q does not exist", id)
		}
		if seenCollections[id] {
			continue
		}
		seenCollections[id] = true
		for _, caseID := range c.CaseIDs {
			if err := addCase(caseID); err != nil {
				return p, err
			}
		}
	}
	if includeMemberships {
		for _, c := range st.Collections {
			members := []string{}
			for _, id := range c.CaseIDs {
				if seenCases[id] {
					members = append(members, id)
				}
			}
			if len(members) > 0 || (seenCollections[c.ID] && len(c.CaseIDs) == 0) {
				p.Collections = append(p.Collections, Collection{ID: c.ID, Name: c.Name, CaseIDs: members})
			}
		}
	}
	return p, nil
}

func encodeCasePackage(p casePackage, format string) ([]byte, error) {
	switch format {
	case "json":
		return json.MarshalIndent(p, "", "  ")
	case "jsonl":
		var b bytes.Buffer
		e := json.NewEncoder(&b)
		if err := e.Encode(struct {
			Type    string `json:"type"`
			Format  string `json:"format"`
			Version int    `json:"version"`
		}{"package", casePackageFormat, 1}); err != nil {
			return nil, err
		}
		for _, c := range p.Cases {
			if err := e.Encode(struct {
				Type string `json:"type"`
				Case
			}{"case", c}); err != nil {
				return nil, err
			}
		}
		for _, c := range p.Collections {
			if err := e.Encode(struct {
				Type string `json:"type"`
				Collection
			}{"collection", c}); err != nil {
				return nil, err
			}
		}
		return b.Bytes(), nil
	default:
		return nil, errors.New("format must be json or jsonl")
	}
}

func sendCasePackage(w http.ResponseWriter, p casePackage, format string) error {
	data, err := encodeCasePackage(p, format)
	if err != nil {
		return err
	}
	contentType := "application/json; charset=utf-8"
	if format == "jsonl" {
		contentType = "application/x-ndjson; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"promptbench-cases.%s\"", format))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
	return nil
}

func (a *API) packageAPI(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/api/cases/example":
		if r.Method != http.MethodGet {
			fail(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
			return true
		}
		p := casePackage{Format: casePackageFormat, Version: 1,
			Cases:       []Case{{ID: "example-case", Variables: map[string]any{"SourceLanguage": "zh-CN", "CurrentText": "你好，世界。", "PriorText": ""}}},
			Collections: []Collection{{ID: "example-collection", Name: "Examples", CaseIDs: []string{"example-case"}}, {ID: "example-empty", Name: "Empty collection", CaseIDs: []string{}}},
		}
		if err := sendCasePackage(w, p, r.URL.Query().Get("format")); err != nil {
			fail(w, http.StatusBadRequest, err)
		}
		return true
	case "/api/cases/import/preview", "/api/cases/import":
		if r.Method != http.MethodPost {
			fail(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
			return true
		}
		var in casePackageImportInput
		if err := decode(w, r, &in); err != nil {
			fail(w, http.StatusBadRequest, err)
			return true
		}
		if r.URL.Path == "/api/cases/import/preview" {
			st, err := a.store.state()
			if err != nil {
				fail(w, http.StatusInternalServerError, errors.New("could not read state"))
				return true
			}
			if st.Version != in.StateVersion {
				fail(w, http.StatusConflict, errStale)
				return true
			}
			p, err := parseCasePackage(in.Format, in.Content)
			if err != nil {
				fail(w, http.StatusBadRequest, err)
				return true
			}
			plan, err := planCasePackageImport(st, p, in.CollectionIDs)
			if err != nil {
				fail(w, http.StatusBadRequest, err)
				return true
			}
			sendJSON(w, http.StatusOK, plan.Preview)
			return true
		}
		var plan casePackageImportPlan
		st, err := a.store.mutateState(in.StateVersion, func(st *State) error {
			p, err := parseCasePackage(in.Format, in.Content)
			if err != nil {
				return err
			}
			plan, err = planCasePackageImport(*st, p, in.CollectionIDs)
			if err != nil {
				return err
			}
			st.Cases = append(st.Cases, plan.NewCases...)
			st.Collections = plan.Collections
			return nil
		})
		if err != nil {
			fail(w, statusFor(err), err)
			return true
		}
		sendJSON(w, http.StatusOK, struct {
			State         StateView         `json:"state"`
			NewCount      int               `json:"new_count"`
			ExistingCount int               `json:"existing_count"`
			CaseIDMap     map[string]string `json:"case_id_map"`
			Warnings      []string          `json:"warnings"`
		}{StateView{State: st, Credentials: a.store.credentialStatuses(st, a.engine.getenv)}, plan.Preview.NewCount, plan.Preview.ExistingCount, plan.CaseIDMap, plan.Preview.Warnings})
		return true
	case "/api/cases/export":
		if r.Method != http.MethodPost {
			fail(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
			return true
		}
		var in struct {
			StateVersion       int64    `json:"state_version"`
			Format             string   `json:"format"`
			CaseIDs            []string `json:"case_ids"`
			CollectionIDs      []string `json:"collection_ids"`
			IncludeMemberships bool     `json:"include_memberships"`
		}
		if err := decode(w, r, &in); err != nil {
			fail(w, http.StatusBadRequest, err)
			return true
		}
		st, err := a.store.state()
		if err != nil {
			fail(w, http.StatusInternalServerError, errors.New("could not read state"))
			return true
		}
		if st.Version != in.StateVersion {
			fail(w, http.StatusConflict, errStale)
			return true
		}
		p, err := exportCasePackage(st, in.CaseIDs, in.CollectionIDs, in.IncludeMemberships)
		if err == nil {
			err = sendCasePackage(w, p, in.Format)
		}
		if err != nil {
			fail(w, http.StatusBadRequest, err)
		}
		return true
	default:
		return false
	}
}
