package main

import (
	"encoding/json"
	"errors"
)

// Version 2 explicitly normalizes the original env-only/OpenAI-only JSON records.
// Results are never rewritten: original raw bytes, hashes, IDs and counts survive.
func (s *Store) migrate() error {
	var version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version > 2 {
		return errors.New("database schema is newer than this Promptbench binary supports; use a newer binary")
	}
	if version == 2 {
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
	var st State
	if err = decodeStored(data, &st); err != nil {
		return err
	}
	changed := false
	for i := range st.Providers {
		p := &st.Providers[i]
		if p.Protocol == "" {
			p.Protocol = openAIChatProtocol
			changed = true
		}
		if p.CredentialRef == "" {
			p.CredentialRef = "legacy:" + p.ID
			changed = true
		}
	}
	if changed {
		st.Version++
		data, err = json.Marshal(st)
		if err != nil {
			return err
		}
		if _, err = tx.Exec("UPDATE state SET version=?,data=? WHERE id=1", st.Version, data); err != nil {
			return err
		}
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
	if _, err = tx.Exec("PRAGMA user_version=2"); err != nil {
		return err
	}
	return tx.Commit()
}
