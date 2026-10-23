package workbench

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestInputContractValidationImpactAndFrozenHistory(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); success(w) }))
	defer provider.Close()
	h := newHarness(t, nil)
	s := fixtureState(provider.URL)
	s.Draft.CaseIDs = []string{"a"}
	s.Draft.Groups = s.Draft.Groups[:1]
	s.Draft.Groups[0].Runs = 1
	s = h.save(s)
	// Legacy unbound templates remain valid and are not forcibly migrated.
	var legacy Batch
	h.api("POST", "/api/runs", runInput(s, 1), 202, &legacy)
	h.wait(legacy.ID)
	contract := InputContract{ID: "shared", Name: "Prepared context", Description: "Already prepared template variables", Fields: map[string]InputField{"CurrentText": {Type: "string", Required: true, Description: "Current source sentence"}, "context": {Type: "object", Required: true, Fields: map[string]InputField{"count": {Type: "integer", Required: true}, "notes": {Type: "array", Required: true, Items: &InputField{Type: "string", Nullable: true}}}}}}
	s.InputContracts = []InputContract{contract}
	s.Templates[0].InputContractID = "shared"
	h.api("PUT", "/api/state", s, 200, &s)
	var impact struct {
		TemplateIDs []string `json:"template_ids"`
		Cases       []struct {
			CaseID string               `json:"case_id"`
			After  []CompatibilityError `json:"after_errors"`
		} `json:"cases"`
	}
	h.api("POST", "/api/input-contracts/impact", map[string]any{"state_version": s.Version, "contract": contract}, 200, &impact)
	if len(impact.TemplateIDs) != 1 || len(impact.Cases) != 2 || impact.Cases[0].After[0].Path != "/context" {
		t.Fatal(impact)
	}
	preview := map[string]any{"state_version": s.Version, "case_id": "a", "group": s.Draft.Groups[0]}
	raw := h.api("POST", "/api/preview", preview, 400, nil)
	if !bytes.Contains(raw, []byte("case a field /context")) {
		t.Fatal(string(raw))
	}
	h.api("POST", "/api/runs", runInput(s, 1), 400, nil)
	if calls.Load() != 1 {
		t.Fatal("invalid Case dispatched")
	}
	h.api("PUT", "/api/cases/a", map[string]any{"state_version": s.Version, "variable_patch": map[string]any{"context": map[string]any{"count": json.Number("9007199254740993"), "notes": []any{"ready", nil}, "extra": "allowed"}}}, 200, &s)
	preview["state_version"] = s.Version
	h.api("POST", "/api/preview", preview, 200, nil)
	var b Batch
	h.api("POST", "/api/runs", runInput(s, 1), 202, &b)
	d := h.wait(b.ID)
	if len(d.Snapshot.InputContracts) != 1 || d.Snapshot.InputContracts[0].Fields["context"].Fields["count"].Type != "integer" {
		t.Fatal(d.Snapshot.InputContracts)
	}
	var before []byte
	h.store.db.QueryRow("SELECT snapshot FROM batches WHERE id=$1", b.ID).Scan(&before)
	changed := contract
	changed.Fields = map[string]InputField{"new_required": {Type: "boolean", Required: true}}
	s.InputContracts = []InputContract{changed}
	h.api("PUT", "/api/state", s, 200, &s)
	preview["state_version"] = s.Version
	h.api("POST", "/api/preview", preview, 400, nil)
	var replay Batch
	h.api("POST", "/api/runs/"+b.ID+"/replay", map[string]any{}, 202, &replay)
	h.wait(replay.ID)
	var after []byte
	h.store.db.QueryRow("SELECT snapshot FROM batches WHERE id=$1", b.ID).Scan(&after)
	if !bytes.Equal(before, after) {
		t.Fatal("contract edit rewrote frozen history")
	}
	h.api("POST", "/api/input-contracts/impact", map[string]any{"state_version": s.Version - 1, "contract": changed}, 409, nil)
	changed.Fields["TargetLanguageNameMap"] = InputField{Type: "object"}
	h.api("POST", "/api/input-contracts/impact", map[string]any{"state_version": s.Version, "contract": changed}, 400, nil)
}
func TestInputContractNestedTypesDoNotCoerceOrDefault(t *testing.T) {
	c := InputContract{ID: "c", Name: "C", Fields: map[string]InputField{"obj": {Type: "object", Required: true, Fields: map[string]InputField{"items": {Type: "array", Required: true, Items: &InputField{Type: "integer"}}, "optional": {Type: "string"}, "nullable": {Type: "string", Required: true, Nullable: true}}}}}
	item := Case{ID: "case", Variables: map[string]any{"obj": map[string]any{"items": []any{json.Number("1"), "2", json.Number("2.5")}, "nullable": nil}, "extra": false}}
	errors := contractErrors(c, item)
	if len(errors) != 2 || errors[0].Path != "/obj/items/1" || errors[1].Path != "/obj/items/2" {
		t.Fatal(errors)
	}
	if _, ok := item.Variables["obj"].(map[string]any)["optional"]; ok {
		t.Fatal("validation added a default")
	}
	bad := c
	bad.Fields = map[string]InputField{"array": {Type: "array"}}
	if err := validateContract(bad); err == nil || !strings.Contains(err.Error(), "items") {
		t.Fatal(err)
	}
}

func TestInputContractNumericExponentsStayLexical(t *testing.T) {
	for _, test := range []struct {
		literal string
		integer bool
	}{
		{"1e999999999", true}, {"1e999999999999999999999999999999999", true},
		{"1e-999999999", false}, {"0e-999999999999999999999999999999999", true},
		{"9007199254740993", true}, {"100e-2", true}, {"10e-2", false},
		{"1.2300e2", true}, {"1.2300e1", false}, {"-0.000", true},
	} {
		c := Case{ID: "numeric", Variables: map[string]any{"n": json.Number(test.literal)}}
		number := InputContract{Fields: map[string]InputField{"n": {Type: "number", Required: true}}}
		if errs := contractErrors(number, c); len(errs) != 0 {
			t.Fatalf("%s rejected as number: %v", test.literal, errs)
		}
		number.Fields["n"] = InputField{Type: "integer", Required: true}
		if errs := contractErrors(number, c); (len(errs) == 0) != test.integer {
			t.Fatalf("%s integer=%v: %v", test.literal, test.integer, errs)
		}
	}
}
