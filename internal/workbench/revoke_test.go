package workbench

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestAtomicClearAndDeleteRequiresFrozenAuth(t *testing.T) {
	for _, withEnv := range []bool{false, true} {
		t.Run(map[bool]string{false: "manual-only", true: "env-fallback"}[withEnv], func(t *testing.T) {
			var calls atomic.Int32
			auth := make(chan string, 4)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				auth <- r.Header.Get("Authorization")
				success(w)
			}))
			defer provider.Close()
			h := newHarness(t, func(string) string { return "fallback-credential" })
			s := oneCase(fixtureState(provider.URL))
			s.Draft.Groups = s.Draft.Groups[:1]
			if withEnv {
				s.Providers[0].APIKeyEnv = "ENV"
			}
			s = h.save(s)
			v := h.credentials(s, map[string]CredentialUpdate{"p": {Action: "set", Key: "revoked-manual"}}, 200)
			s = v.State
			d := h.run(s)
			if <-auth != "Bearer revoked-manual" {
				t.Fatal("manual override not used")
			}
			removed := s
			removed.Providers = []Provider{}
			removed.Draft.Groups = []Group{}
			v = h.credentials(removed, map[string]CredentialUpdate{"p": {Action: "clear"}}, 200)
			if len(v.Providers) != 0 {
				t.Fatal("profile not deleted")
			}
			var n int
			if err := h.store.db.QueryRow("SELECT count(*) FROM credentials WHERE ref=?", s.Providers[0].CredentialRef).Scan(&n); err != nil || n != 0 {
				t.Fatal("deleted profile secret not revoked", err)
			}
			if withEnv {
				var replay Batch
				h.api("POST", "/api/runs/"+d.Batch.ID+"/replay", map[string]any{}, 202, &replay)
				again := h.wait(replay.ID)
				if again.Batch.Completed != 1 || <-auth != "Bearer fallback-credential" {
					t.Fatal("frozen env fallback failed")
				}
			} else {
				h.api("POST", "/api/runs/"+d.Batch.ID+"/replay", map[string]any{}, 400, nil)
				if calls.Load() != 1 {
					t.Fatal("revoked authenticated replay sent anonymous request")
				}
			}
		})
	}
}

func TestStaleLegacyTabGetsConflictBeforeProtocolValidation(t *testing.T) {
	h := newHarness(t, nil)
	old := h.view().State
	h.credentials(old, nil, 200)
	for i := range old.Providers {
		old.Providers[i].Protocol = ""
		old.Providers[i].CredentialRef = ""
	}
	h.api("PUT", "/api/state", old, 409, nil)
}
