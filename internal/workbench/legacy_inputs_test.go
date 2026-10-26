package workbench

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLegacyInputMetadataReadOnlyAndFrozenReplay(t *testing.T) {
	calls := make(chan string, 4)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		calls <- string(body)
		success(w)
	}))
	defer provider.Close()
	h := newHarness(t, nil)
	s := oneCase(fixtureState(provider.URL))
	s.Draft.Groups = s.Draft.Groups[:1]
	s.Cases[0].Variables["large"] = json.Number("9007199254740993")
	s.Cases[0].Variables["decimal"] = json.Number("1.00")
	s = h.save(s)
	s = h.credentials(s, map[string]CredentialUpdate{"p": {Action: "set", Key: "synthetic-legacy-input-key"}}, 200).State
	original := h.run(s)
	originalRequest := <-calls
	var snapshotBefore, resultBefore, stateBefore, ciphertextBefore []byte
	if err := h.store.db.QueryRow("SELECT snapshot FROM batches WHERE id=$1", original.Batch.ID).Scan(&snapshotBefore); err != nil {
		t.Fatal(err)
	}
	if err := h.store.db.QueryRow("SELECT data FROM results WHERE batch_id=$1", original.Batch.ID).Scan(&resultBefore); err != nil {
		t.Fatal(err)
	}
	if err := h.store.db.QueryRow("SELECT data FROM state WHERE id=1").Scan(&stateBefore); err != nil {
		t.Fatal(err)
	}
	if err := h.store.db.QueryRow("SELECT ciphertext FROM credentials WHERE ref=$1", s.Providers[0].CredentialRef).Scan(&ciphertextBefore); err != nil {
		t.Fatal(err)
	}
	contracts := json.RawMessage(`[{"id":"legacy-input","name":"Old input","fields":{"CurrentText":{"type":"string","required":true}}}]`)
	withLegacy := func(raw []byte) []byte {
		t.Helper()
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatal(err)
		}
		var templates []map[string]json.RawMessage
		if err := json.Unmarshal(fields["templates"], &templates); err != nil {
			t.Fatal(err)
		}
		templates[0]["input_contract_id"] = json.RawMessage(`"legacy-input"`)
		fields["templates"], _ = json.Marshal(templates)
		fields["input_contracts"] = contracts
		out, err := json.Marshal(fields)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	legacyState, legacySnapshot := withLegacy(stateBefore), withLegacy(snapshotBefore)
	if _, err := h.store.db.Exec("UPDATE state SET data=$1 WHERE id=1", legacyState); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.db.Exec("UPDATE batches SET snapshot=$1 WHERE id=$2", legacySnapshot, original.Batch.ID); err != nil {
		t.Fatal(err)
	}
	read := h.api("GET", "/api/state", nil, 200, &s)
	if bytes.Contains(read, []byte("input_contract")) || !bytes.Contains(read, []byte("9007199254740993")) || !bytes.Contains(read, []byte("1.00")) {
		t.Fatalf("active state retained obsolete metadata or lost numbers: %s", read)
	}
	var afterRead []byte
	if err := h.store.db.QueryRow("SELECT data FROM state WHERE id=1").Scan(&afterRead); err != nil || !bytes.Equal(afterRead, legacyState) {
		t.Fatal("reading old state rewrote its blob", err)
	}
	h.api("POST", "/api/input-contracts/impact", map[string]any{}, 404, nil)
	h.api("PUT", "/api/state", json.RawMessage(legacyState), 400, nil)
	h.api("PUT", "/api/state", s, 200, &s)
	var afterSave, ciphertextAfter []byte
	if err := h.store.db.QueryRow("SELECT data FROM state WHERE id=1").Scan(&afterSave); err != nil {
		t.Fatal(err)
	}
	if err := h.store.db.QueryRow("SELECT ciphertext FROM credentials WHERE ref=$1", s.Providers[0].CredentialRef).Scan(&ciphertextAfter); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(afterSave, []byte("input_contract")) || !bytes.Contains(afterSave, []byte("9007199254740993")) || !bytes.Contains(afterSave, []byte("1.00")) || !bytes.Equal(ciphertextBefore, ciphertextAfter) {
		t.Fatal("normal save lost Case numeric literals/credentials or kept active contracts")
	}
	for _, suffix := range []string{"", "/export"} {
		var d Detail
		h.api("GET", "/api/runs/"+original.Batch.ID+suffix, nil, 200, &d)
		if !bytes.Equal(d.Snapshot.LegacyInputContracts, contracts) || d.Snapshot.Templates[0].InputContractID != "legacy-input" {
			t.Fatal("history lost legacy input metadata")
		}
	}
	var replay Batch
	h.api("POST", "/api/runs/"+original.Batch.ID+"/replay", map[string]any{}, 202, &replay)
	replayed := h.wait(replay.ID)
	if <-calls != originalRequest || !bytes.Equal(replayed.Snapshot.LegacyInputContracts, contracts) || replayed.Snapshot.Templates[0].InputContractID != "legacy-input" {
		t.Fatal("replay did not use frozen request/metadata")
	}
	fresh := h.run(s)
	<-calls
	if len(fresh.Snapshot.LegacyInputContracts) != 0 || fresh.Snapshot.Templates[0].InputContractID != "" {
		t.Fatal("new generation froze active contract metadata")
	}
	var snapshotAfter, resultAfter []byte
	if err := h.store.db.QueryRow("SELECT snapshot FROM batches WHERE id=$1", original.Batch.ID).Scan(&snapshotAfter); err != nil {
		t.Fatal(err)
	}
	if err := h.store.db.QueryRow("SELECT data FROM results WHERE batch_id=$1", original.Batch.ID).Scan(&resultAfter); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(legacySnapshot, snapshotAfter) || !bytes.Equal(resultBefore, resultAfter) {
		t.Fatal("read/save/replay changed immutable history blobs")
	}
}
