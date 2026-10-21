package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
)

// Version 2 explicitly normalizes the original env-only/OpenAI-only JSON records.
// Results are never rewritten: original raw bytes, hashes, IDs and counts survive.
func (s *Store) migrate() error {
	var version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version > 3 {
		return errors.New("database schema is newer than this Promptbench binary supports; use a newer binary")
	}
	if version == 3 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var data []byte
	if err = tx.QueryRow("SELECT data FROM state WHERE id=1").Scan(&data); err != nil {
		return err
	}
	original := append([]byte(nil), data...)
	data, converted, err := migrateCaseState(data)
	if err != nil {
		return err
	}
	if _, err = tx.Exec("CREATE TABLE IF NOT EXISTS migration_archives (id INTEGER PRIMARY KEY, from_version INTEGER NOT NULL, state_data BLOB NOT NULL)"); err != nil {
		return err
	}
	if converted {
		if _, err = tx.Exec("INSERT INTO migration_archives(from_version,state_data) VALUES(?,?)", version, original); err != nil {
			return err
		}
	}
	var st State
	if err = decodeStored(data, &st); err != nil {
		return err
	}
	changed := converted
	providersChanged := false
	for i := range st.Providers {
		p := &st.Providers[i]
		if p.Protocol == "" {
			p.Protocol = openAIChatProtocol
			changed = true
			providersChanged = true
		}
		if p.CredentialRef == "" {
			p.CredentialRef = "legacy:" + p.ID
			changed = true
			providersChanged = true
		}
	}
	if err = validateState(st); err != nil {
		return fmt.Errorf("Case migration: converted state is invalid; resolve the reported configuration before retrying: %w", err)
	}
	if changed {
		st.Version++
		var root map[string]json.RawMessage
		if err = json.Unmarshal(data, &root); err != nil {
			return err
		}
		root["version"], _ = json.Marshal(st.Version)
		if providersChanged {
			root["providers"], _ = json.Marshal(st.Providers)
		}
		data, err = json.Marshal(root)
		if err != nil {
			return err
		}
		if _, err = tx.Exec("UPDATE state SET version=?,data=? WHERE id=1", st.Version, data); err != nil {
			return err
		}
	}
	if version == 2 {
		return finishCaseMigration(tx)
	}
	type legacyBatch struct {
		id       string
		snapshot Snapshot
	}
	batches := []legacyBatch{}
	rows, err := tx.Query("SELECT id,snapshot FROM batches")
	if err != nil {
		return err
	}
	for rows.Next() {
		var b legacyBatch
		if err = rows.Scan(&b.id, &data); err != nil {
			rows.Close()
			return err
		}
		if err = decodeStored(data, &b.snapshot); err != nil {
			rows.Close()
			return err
		}
		batches = append(batches, b)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, b := range batches {
		providers := map[string]string{}
		for i := range b.snapshot.Providers {
			p := &b.snapshot.Providers[i]
			if p.Protocol == "" {
				p.Protocol = openAIChatProtocol
			}
			if p.CredentialRef == "" {
				p.CredentialRef = "legacy:" + p.ID
			}
			providers[p.ID] = p.CredentialRef
		}
		groups := map[string]string{}
		for _, g := range b.snapshot.Groups {
			groups[g.ID] = g.ProviderID
		}
		originals := map[[2]string]string{}
		resultRows, err := tx.Query("SELECT data FROM results WHERE batch_id=? ORDER BY seq", b.id)
		if err != nil {
			return err
		}
		for resultRows.Next() {
			if err = resultRows.Scan(&data); err != nil {
				resultRows.Close()
				return err
			}
			var r Result
			if err = json.Unmarshal(data, &r); err != nil {
				resultRows.Close()
				return err
			}
			key := [2]string{r.CaseID, r.GroupID}
			if originals[key] == "" && r.RawRequest != "" {
				originals[key] = r.RawRequest
			}
		}
		err = resultRows.Err()
		resultRows.Close()
		if err != nil {
			return err
		}
		for i := range b.snapshot.Requests {
			f := &b.snapshot.Requests[i]
			if f.Protocol == "" {
				f.Protocol = openAIChatProtocol
			}
			if f.CredentialRef == "" {
				id := groups[f.GroupID]
				if id == "" {
					id = f.GroupID
				}
				f.CredentialRef = providers[id]
				if f.CredentialRef == "" {
					f.CredentialRef = "legacy:" + id
				}
			}
			f.RequiresAuth = f.RequiresAuth || f.APIKeyEnv != ""
			if f.RawRequest == "" {
				f.RawRequest = originals[[2]string{f.CaseID, f.GroupID}]
				if f.RawRequest == "" {
					f.RawRequest = string(f.Request)
				}
			}
			if !json.Valid([]byte(f.RawRequest)) {
				return errors.New("legacy snapshot contains invalid request JSON; migration aborted")
			}
		}
		for i := range b.snapshot.Requests {
			f := &b.snapshot.Requests[i]
			if f.Method == "" {
				f.Method = "POST"
			}
			if f.Headers == nil {
				f.Headers = map[string]string{"Content-Type": "application/json"}
			}
		}
		data, err = json.Marshal(b.snapshot)
		if err != nil {
			return err
		}
		if _, err = tx.Exec("UPDATE batches SET snapshot=? WHERE id=?", data, b.id); err != nil {
			return err
		}
	}
	return finishCaseMigration(tx)
}

func finishCaseMigration(tx *sql.Tx) error {
	if _, err := tx.Exec("PRAGMA user_version=3"); err != nil {
		return err
	}
	return tx.Commit()
}

// Work on raw fields so unrelated current-state data is not reconstructed.
// Historical snapshots and result blobs are deliberately outside this conversion.
func migrateCaseState(data []byte) ([]byte, bool, error) {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, false, err
	}
	var cases []map[string]json.RawMessage
	if err := json.Unmarshal(root["cases"], &cases); err != nil {
		return nil, false, err
	}
	routes := map[string][]Target{}
	routeOwners := map[string]string{}
	ids := map[string]string{}
	missing := []string{}
	for _, c := range cases {
		var id string
		if err := json.Unmarshal(c["id"], &id); err != nil || id == "" {
			return nil, false, errors.New("Case migration: missing or invalid Case id")
		}
		for k := range c {
			if k != "id" && k != "name" && k != "description" && k != "variables" {
				return nil, false, fmt.Errorf("Case migration: Case %q has unsupported field %q; export and resolve this field before retrying", id, k)
			}
		}
		for _, k := range []string{"name", "description"} {
			if raw, ok := c[k]; ok {
				var text string
				if err := json.Unmarshal(raw, &text); err != nil {
					return nil, false, fmt.Errorf("Case migration: Case %q has invalid %s", id, k)
				}
			}
		}
		if _, exists := ids[id]; exists {
			return nil, false, fmt.Errorf("Case migration: duplicate Case id %q", id)
		}
		ids[id] = newID()
		var vars map[string]json.RawMessage
		if err := json.Unmarshal(c["variables"], &vars); err != nil || vars == nil {
			return nil, false, fmt.Errorf("Case migration: Case %q variables must be an object", id)
		}
		if raw, ok := vars["TargetLanguageNameMap"]; ok {
			var source string
			if err := json.Unmarshal(vars["SourceLanguage"], &source); err != nil || source == "" || strings.TrimSpace(source) != source {
				return nil, false, fmt.Errorf("Case migration: Case %q target map has no representable exact SourceLanguage; resolve it before retrying", id)
			}
			var targets map[string]string
			if err := json.Unmarshal(raw, &targets); err != nil || len(targets) == 0 {
				return nil, false, fmt.Errorf("Case migration: Case %q has an empty or invalid target map", id)
			}
			keys := make([]string, 0, len(targets))
			for key, name := range targets {
				if key == "" || name == "" || strings.TrimSpace(key) != key || strings.TrimSpace(name) != name {
					return nil, false, fmt.Errorf("Case migration: Case %q has an unrepresentable target %q", id, key)
				}
				keys = append(keys, key)
			}
			sort.Strings(keys)
			list := []Target{}
			for _, key := range keys {
				list = append(list, Target{Key: key, Name: targets[key]})
			}
			if previous, ok := routes[source]; ok && !reflect.DeepEqual(previous, list) {
				return nil, false, fmt.Errorf("Case migration: conflicting target maps for SourceLanguage %q in Cases %q and %q; resolve the conflict before retrying", source, routeOwners[source], id)
			}
			routes[source], routeOwners[source] = list, id
			delete(vars, "TargetLanguageNameMap")
		} else {
			missing = append(missing, id)
		}
		c["id"], _ = json.Marshal(ids[id])
		c["variables"], _ = json.Marshal(vars)
		delete(c, "name")
		delete(c, "description")
	}
	if len(routes) > 0 && len(missing) > 0 {
		return nil, false, fmt.Errorf("Case migration: Cases %v have no target map while other Cases do; resolve their intended language behavior before retrying", missing)
	}
	var draft map[string]json.RawMessage
	if err := json.Unmarshal(root["draft"], &draft); err != nil || draft == nil {
		return nil, false, errors.New("Case migration: invalid draft")
	}
	remap := func(obj map[string]json.RawMessage, field string) error {
		raw, ok := obj[field]
		if !ok {
			return nil
		}
		var refs []string
		if err := json.Unmarshal(raw, &refs); err != nil {
			return err
		}
		for i, id := range refs {
			next, ok := ids[id]
			if !ok {
				return fmt.Errorf("Case migration: %s references unknown Case %q", field, id)
			}
			refs[i] = next
		}
		obj[field], _ = json.Marshal(refs)
		return nil
	}
	for _, field := range []string{"case_ids", "excluded_case_ids"} {
		if err := remap(draft, field); err != nil {
			return nil, false, err
		}
	}
	var collections []map[string]json.RawMessage
	if raw, ok := root["collections"]; ok {
		if err := json.Unmarshal(raw, &collections); err != nil {
			return nil, false, err
		}
	}
	for _, collection := range collections {
		if err := remap(collection, "case_ids"); err != nil {
			return nil, false, err
		}
	}
	if len(routes) > 0 {
		var groups []map[string]json.RawMessage
		if err := json.Unmarshal(draft["groups"], &groups); err != nil {
			return nil, false, err
		}
		sources := make([]string, 0, len(routes))
		for source := range routes {
			sources = append(sources, source)
		}
		sort.Strings(sources)
		for _, group := range groups {
			var existing []LanguageRoute
			if raw, ok := group["language_routes"]; ok {
				if err := json.Unmarshal(raw, &existing); err != nil {
					return nil, false, err
				}
			}
			for _, source := range sources {
				found := false
				for _, route := range existing {
					if route.SourceLanguage == source {
						found = true
						if !reflect.DeepEqual(route.Targets, routes[source]) {
							return nil, false, fmt.Errorf("Case migration: existing group route conflicts with Case target map for %q", source)
						}
					}
				}
				if !found {
					existing = append(existing, LanguageRoute{SourceLanguage: source, Targets: routes[source]})
				}
			}
			group["language_routes"], _ = json.Marshal(existing)
		}
		draft["groups"], _ = json.Marshal(groups)
	}
	root["cases"], _ = json.Marshal(cases)
	root["draft"], _ = json.Marshal(draft)
	root["collections"], _ = json.Marshal(collections)
	out, err := json.Marshal(root)
	return out, len(cases) > 0, err
}
