package workbench

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

type InputField struct {
	Type        string                `json:"type"`
	Required    bool                  `json:"required"`
	Nullable    bool                  `json:"nullable"`
	Description string                `json:"description"`
	Fields      map[string]InputField `json:"fields,omitempty"`
	Items       *InputField           `json:"items,omitempty"`
}
type InputContract struct {
	ID          string                `json:"id"`
	Name        string                `json:"name"`
	Description string                `json:"description"`
	Fields      map[string]InputField `json:"fields"`
}
type CompatibilityError struct {
	CaseID  string `json:"case_id"`
	Path    string `json:"path"`
	Message string `json:"message"`
}

func validateContract(c InputContract) error {
	if !validID(c.ID) || strings.TrimSpace(c.Name) == "" {
		return fmt.Errorf("input contract id and name required")
	}
	if _, ok := c.Fields["TargetLanguageNameMap"]; ok {
		return fmt.Errorf("TargetLanguageNameMap is runtime-injected, not a Case input field")
	}
	return validateFields(c.Fields, 0)
}
func validateFields(fields map[string]InputField, depth int) error {
	if depth > 32 {
		return fmt.Errorf("input contract nesting exceeds 32")
	}
	for name, f := range fields {
		if name == "" {
			return fmt.Errorf("input field name required")
		}
		if err := validateField(f, depth); err != nil {
			return fmt.Errorf("field %s: %w", name, err)
		}
	}
	return nil
}
func validateField(f InputField, depth int) error {
	switch f.Type {
	case "string", "number", "integer", "boolean":
	case "object":
		if err := validateFields(f.Fields, depth+1); err != nil {
			return err
		}
	case "array":
		if f.Items == nil {
			return fmt.Errorf("array items definition required")
		}
		if depth >= 32 {
			return fmt.Errorf("input contract nesting exceeds 32")
		}
		if err := validateField(*f.Items, depth+1); err != nil {
			return err
		}
	default:
		return fmt.Errorf("type must be string, number, integer, boolean, object or array")
	}
	if f.Type != "object" && len(f.Fields) > 0 {
		return fmt.Errorf("only object fields may define fields")
	}
	if f.Type != "array" && f.Items != nil {
		return fmt.Errorf("only array fields may define items")
	}
	return nil
}
func contractErrors(c InputContract, item Case) []CompatibilityError {
	out := []CompatibilityError{}
	checkFields(c.Fields, item.Variables, "", item.ID, &out)
	return out
}
func checkFields(fields map[string]InputField, values map[string]any, prefix, caseID string, out *[]CompatibilityError) {
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		f := fields[name]
		path := prefix + "/" + strings.ReplaceAll(strings.ReplaceAll(name, "~", "~0"), "/", "~1")
		v, ok := values[name]
		if !ok {
			if f.Required {
				*out = append(*out, CompatibilityError{caseID, path, "required field is missing"})
			}
			continue
		}
		checkField(f, v, path, caseID, out)
	}
}
func checkField(f InputField, v any, path, caseID string, out *[]CompatibilityError) {
	add := func(message string) { *out = append(*out, CompatibilityError{caseID, path, message}) }
	if v == nil {
		if !f.Nullable {
			add("null is not allowed")
		}
		return
	}
	valid := false
	switch f.Type {
	case "string":
		_, valid = v.(string)
	case "boolean":
		_, valid = v.(bool)
	case "number", "integer":
		switch value := v.(type) {
		case json.Number:
			valid = f.Type == "number" || integerLiteral(value.String())
		case float64:
			valid = !math.IsNaN(value) && !math.IsInf(value, 0) && (f.Type == "number" || math.Trunc(value) == value)
		case int, int64:
			valid = true
		}
	case "object":
		if obj, ok := v.(map[string]any); ok {
			valid = true
			checkFields(f.Fields, obj, path, caseID, out)
		}
	case "array":
		if arr, ok := v.([]any); ok {
			valid = true
			for i, item := range arr {
				checkField(*f.Items, item, fmt.Sprintf("%s/%d", path, i), caseID, out)
			}
		}
	}
	if !valid {
		add("expected " + f.Type)
	}
}

// Compare decimal scale to exponent without expanding arbitrary-size numbers.
// JSON decoding already guarantees the literal's numeric grammar.
func integerLiteral(n string) bool {
	mantissa, exponent := n, int64(0)
	if pos := strings.IndexAny(n, "eE"); pos >= 0 {
		mantissa = n[:pos]
		var err error
		exponent, err = strconv.ParseInt(n[pos+1:], 10, 64)
		if err != nil {
			if n[pos+1] == '-' {
				exponent = math.MinInt64
			} else {
				exponent = math.MaxInt64
			}
		}
	}
	fraction := 0
	if dot := strings.IndexByte(mantissa, '.'); dot >= 0 {
		fraction = len(mantissa) - dot - 1
	}
	trailing := 0
	nonzero := false
	for i := len(mantissa) - 1; i >= 0; i-- {
		c := mantissa[i]
		if c == '.' || c == '-' {
			continue
		}
		if c != '0' {
			nonzero = true
			break
		}
		trailing++
	}
	return !nonzero || exponent >= int64(fraction-trailing)
}

func validateCaseContract(s State, t Template, c Case) error {
	if t.InputContractID == "" {
		return nil
	}
	for _, contract := range s.InputContracts {
		if contract.ID == t.InputContractID {
			errs := contractErrors(contract, c)
			if len(errs) > 0 {
				messages := make([]string, len(errs))
				for i, e := range errs {
					messages[i] = fmt.Sprintf("case %s field %s: %s", e.CaseID, e.Path, e.Message)
				}
				return fmt.Errorf("%s", strings.Join(messages, "; "))
			}
			return nil
		}
	}
	return fmt.Errorf("template %s input contract not found", t.ID)
}
func (a *API) inputContractAPI(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/api/input-contracts/impact" {
		return false
	}
	if r.Method != "POST" {
		fail(w, 405, fmt.Errorf("method not allowed"))
		return true
	}
	var in struct {
		StateVersion int64         `json:"state_version"`
		Contract     InputContract `json:"contract"`
	}
	if err := decode(w, r, &in); err != nil {
		fail(w, 400, err)
		return true
	}
	s, err := a.store.state()
	if err != nil {
		fail(w, 500, fmt.Errorf("could not read state"))
		return true
	}
	if s.Version != in.StateVersion {
		fail(w, 409, errStale)
		return true
	}
	if err := validateContract(in.Contract); err != nil {
		fail(w, 400, err)
		return true
	}
	ids := []string{}
	for _, t := range s.Templates {
		if t.InputContractID == in.Contract.ID {
			ids = append(ids, t.ID)
		}
	}
	var old *InputContract
	for i := range s.InputContracts {
		if s.InputContracts[i].ID == in.Contract.ID {
			old = &s.InputContracts[i]
		}
	}
	type impact struct {
		CaseID string               `json:"case_id"`
		Before []CompatibilityError `json:"before_errors"`
		After  []CompatibilityError `json:"after_errors"`
	}
	cases := []impact{}
	for _, c := range s.Cases {
		before := []CompatibilityError{}
		if old != nil {
			before = contractErrors(*old, c)
		}
		cases = append(cases, impact{c.ID, before, contractErrors(in.Contract, c)})
	}
	sendJSON(w, 200, map[string]any{"state_version": s.Version, "template_ids": ids, "cases": cases})
	return true
}
