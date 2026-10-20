package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"text/template"
)

const maxRender = 1 << 20

var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

type limitedBuffer struct{ bytes.Buffer }

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if len(p) > maxRender-b.Len() {
		return 0, fmt.Errorf("rendered message exceeds 1 MiB")
	}
	return b.Buffer.Write(p)
}
func (b *limitedBuffer) WriteString(s string) (int, error) {
	if len(s) > maxRender-b.Len() {
		return 0, fmt.Errorf("rendered message exceeds 1 MiB")
	}
	return b.Buffer.WriteString(s)
}
func validID(id string) bool { return len(id) > 0 && len(id) <= 128 && strings.TrimSpace(id) == id }
func validateGroup(g Group) error {
	if !validID(g.ID) || strings.TrimSpace(g.Name) == "" {
		return fmt.Errorf("group id and name required")
	}
	if strings.TrimSpace(g.Model) == "" {
		return fmt.Errorf("group %s: model required", g.Name)
	}
	if g.Runs < 1 || g.Runs > 1000 {
		return fmt.Errorf("group %s: runs must be 1–1000", g.Name)
	}
	for k := range g.Parameters {
		switch strings.ToLower(k) {
		case "authorization", "api_key", "api-key", "apikey", "headers", "extra_headers":
			return fmt.Errorf("parameter %q may contain credentials; use provider credentials", k)
		}
	}
	return nil
}
func validateState(s State) error {
	if s.Settings.DefaultRuns < 1 || s.Settings.DefaultRuns > 1000 || s.Settings.Concurrency < 1 || s.Settings.Concurrency > 20 || s.Settings.TimeoutSeconds < 1 || s.Settings.TimeoutSeconds > 3600 {
		return fmt.Errorf("settings require runs 1–1000, concurrency 1–20, timeout 1–3600")
	}
	cases := map[string]bool{}
	templates := map[string]bool{}
	providers := map[string]bool{}
	for _, c := range s.Cases {
		if !validID(c.ID) || cases[c.ID] || strings.TrimSpace(c.Name) == "" || c.Variables == nil {
			return fmt.Errorf("cases require unique id, name and variables object")
		}
		cases[c.ID] = true
	}
	for _, t := range s.Templates {
		if !validID(t.ID) || templates[t.ID] || strings.TrimSpace(t.Name) == "" || len(t.Messages) == 0 {
			return fmt.Errorf("templates require unique id, name and messages")
		}
		templates[t.ID] = true
		for _, m := range t.Messages {
			if err := validMessage(m); err != nil {
				return err
			}
			if _, err := template.New("message").Parse(m.Content); err != nil {
				return fmt.Errorf("template %s: %w", t.Name, err)
			}
		}
	}
	for _, p := range s.Providers {
		if !validID(p.ID) || providers[p.ID] || strings.TrimSpace(p.Name) == "" {
			return fmt.Errorf("providers require unique id and name")
		}
		providers[p.ID] = true
		if err := validateProvider(p); err != nil {
			return err
		}
	}
	seen := map[string]bool{}
	for _, id := range s.Draft.CaseIDs {
		if !cases[id] || seen[id] {
			return fmt.Errorf("draft case ids must exist and be unique")
		}
		seen[id] = true
	}
	seen = map[string]bool{}
	for _, g := range s.Draft.Groups {
		if err := validateGroup(g); err != nil {
			return err
		}
		if seen[g.ID] || !templates[g.TemplateID] || !providers[g.ProviderID] {
			return fmt.Errorf("draft group ids must be unique and sources must exist")
		}
		for _, p := range s.Providers {
			if p.ID == g.ProviderID {
				adapter, _ := lookupProtocol(p.Protocol)
				if err := validateParameters(g.Parameters, adapter.Info()); err != nil {
					return err
				}
				break
			}
		}
		seen[g.ID] = true
	}
	return nil
}
func validMessage(m Message) error {
	if strings.TrimSpace(m.Role) == "" {
		return fmt.Errorf("message role required")
	}
	return nil
}
func renderRequest(s State, caseID string, g Group) (FrozenRequest, error) {
	var f FrozenRequest
	if err := validateGroup(g); err != nil {
		return f, err
	}
	var c *Case
	var t *Template
	var p *Provider
	for i := range s.Cases {
		if s.Cases[i].ID == caseID {
			c = &s.Cases[i]
		}
	}
	for i := range s.Templates {
		if s.Templates[i].ID == g.TemplateID {
			t = &s.Templates[i]
		}
	}
	for i := range s.Providers {
		if s.Providers[i].ID == g.ProviderID {
			p = &s.Providers[i]
		}
	}
	if c == nil || t == nil || p == nil {
		return f, fmt.Errorf("case, template or provider not found")
	}
	adapter, err := lookupProtocol(p.Protocol)
	if err != nil {
		return f, err
	}
	messages := []Message{}
	for _, m := range t.Messages {
		if err = validMessage(m); err != nil {
			return f, err
		}
		tmpl, e := template.New("message").Parse(m.Content)
		if e != nil {
			return f, e
		}
		var out limitedBuffer
		if e = tmpl.Execute(&out, c.Variables); e != nil {
			return f, fmt.Errorf("render %s: %w", c.Name, e)
		}
		messages = append(messages, Message{m.Role, out.String()})
	}
	prepared, err := adapter.Prepare(*p, g.Model, messages, g.Parameters)
	if err != nil {
		return f, err
	}
	if err = validateFrozenHeaders(prepared.Headers); err != nil {
		return f, err
	}
	hash := sha256.Sum256(prepared.Body)
	return FrozenRequest{CaseID: c.ID, CaseName: c.Name, GroupID: g.ID, GroupName: g.Name, Model: g.Model, Protocol: p.Protocol, CredentialRef: p.CredentialRef, RequiresAuth: p.APIKeyEnv != "", Endpoint: prepared.Endpoint, Method: prepared.Method, Headers: prepared.Headers, APIKeyEnv: p.APIKeyEnv, Request: prepared.Body, RawRequest: string(prepared.Body), PromptHash: hex.EncodeToString(hash[:]), Runs: g.Runs}, nil
}
func freeze(s State, in RunInput) (Snapshot, error) {
	snap := Snapshot{Cases: []Case{}, Templates: []Template{}, Providers: []Provider{}, Groups: []Group{}, CaseIDs: in.CaseIDs, TimeoutSeconds: s.Settings.TimeoutSeconds, Requests: []FrozenRequest{}}
	if in.Concurrency < 1 || in.Concurrency > 20 {
		return snap, fmt.Errorf("concurrency must be 1–20")
	}
	if len(in.CaseIDs) == 0 {
		return snap, fmt.Errorf("select at least one case")
	}
	groups := map[string]bool{}
	templates := map[string]bool{}
	providers := map[string]bool{}
	total := 0
	for _, g := range in.Groups {
		if groups[g.ID] {
			return snap, fmt.Errorf("duplicate group id")
		}
		groups[g.ID] = true
		if !g.Enabled {
			continue
		}
		if err := validateGroup(g); err != nil {
			return snap, err
		}
		snap.Groups = append(snap.Groups, g)
		templates[g.TemplateID] = true
		providers[g.ProviderID] = true
		total += g.Runs * len(in.CaseIDs)
	}
	if total == 0 || total > 100000 {
		return snap, fmt.Errorf("batch must contain 1–100000 attempts")
	}
	cases := map[string]bool{}
	for _, id := range in.CaseIDs {
		if cases[id] {
			return snap, fmt.Errorf("duplicate case id")
		}
		cases[id] = true
		for _, g := range snap.Groups {
			f, err := renderRequest(s, id, g)
			if err != nil {
				return snap, err
			}
			snap.Requests = append(snap.Requests, f)
		}
	}
	for _, c := range s.Cases {
		if cases[c.ID] {
			snap.Cases = append(snap.Cases, c)
		}
	}
	for _, t := range s.Templates {
		if templates[t.ID] {
			snap.Templates = append(snap.Templates, t)
		}
	}
	for _, p := range s.Providers {
		if providers[p.ID] {
			snap.Providers = append(snap.Providers, p)
		}
	}
	return snap, nil
}
