package workbench

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestPostgresBootstrapAndHistoryRoundTrip(t *testing.T) {
	target := newTestStoreTarget(t)
	s := target.open(t)
	st, err := s.state()
	if err != nil {
		t.Fatal(err)
	}
	st, err = s.saveState(st, map[string]CredentialUpdate{st.Providers[0].ID: {Action: "set", Key: "synthetic-roundtrip-key"}})
	if err != nil {
		t.Fatal(err)
	}
	var originalState []byte
	if err = s.db.QueryRow("SELECT data FROM state WHERE id=1").Scan(&originalState); err != nil {
		t.Fatal(err)
	}
	originalState = append(append([]byte(" "), originalState...), '\n')
	if _, err = s.db.Exec("UPDATE state SET data=$1 WHERE id=1", originalState); err != nil {
		t.Fatal(err)
	}
	d := Detail{Batch: Batch{ID: "history", Status: "completed", CreatedAt: now(), Completed: 1, Total: 1}, Results: []Result{{ID: "result", GroupID: "g", CaseID: "c", Iteration: 1, Status: "completed", RawResponse: "original response"}}}
	if err = s.create(d); err != nil {
		t.Fatal(err)
	}
	snapshot := []byte(" {\"cases\":[],\"requests\":[],\"unknown\":9007199254740993}\n")
	result := []byte(" {\"id\":\"result\",\"status\":\"completed\",\"raw_response\":\"original response\"}\n")
	archive := []byte(" {\"version\":9007199254740993}\n")
	if _, err = s.db.Exec("UPDATE batches SET snapshot=$1 WHERE id='history'", snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec("UPDATE results SET data=$1 WHERE id='result'", result); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec("INSERT INTO migration_archives(from_version,state_data) VALUES(3,$1)", archive); err != nil {
		t.Fatal(err)
	}
	read := func(store *Store) [][]byte {
		t.Helper()
		queries := []string{"SELECT data FROM state WHERE id=1", "SELECT summary FROM batches WHERE id='history'", "SELECT snapshot FROM batches WHERE id='history'", "SELECT data FROM results WHERE id='result'", "SELECT state_data FROM migration_archives", "SELECT ciphertext FROM credentials"}
		values := make([][]byte, len(queries))
		for i, q := range queries {
			if err := store.db.QueryRow(q).Scan(&values[i]); err != nil {
				t.Fatal(err)
			}
		}
		return values
	}
	before := read(s)
	s.close()
	s = target.open(t)
	after := read(s)
	for i := range before {
		if !bytes.Equal(before[i], after[i]) {
			t.Fatalf("stored bytes changed at column %d", i)
		}
	}
	restored, err := s.state()
	if err != nil || restored.Version != st.Version {
		t.Fatal("reopen reseeded state", err)
	}
	detail, err := s.detail("history")
	if err != nil || detail.Results[0].RawResponse != "original response" {
		t.Fatal("history roundtrip failed", err)
	}
}

func TestPostgresSessionLossDoesNotReconnect(t *testing.T) {
	var calls atomic.Int32
	entered := make(chan struct{})
	release := make(chan struct{}, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			close(entered)
			<-release
		}
		success(w)
	}))
	defer provider.Close()
	target := newTestStoreTarget(t)
	store := target.open(t)
	engine := newEngine(store, func(string) string { return "" })
	defer engine.close()
	defer close(release)
	state := oneCase(fixtureState(provider.URL))
	state.Draft.Groups = state.Draft.Groups[:1]
	current, err := store.state()
	if err != nil {
		t.Fatal(err)
	}
	state.Version = current.Version
	state, err = store.saveState(state, nil)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := freeze(state, runInput(state, 1))
	if err != nil {
		t.Fatal(err)
	}
	for i := range snapshot.Requests {
		snapshot.Requests[i].Runs = 2
	}
	batch, err := engine.start("session loss", snapshot, 1, "", state.Version)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("provider was not called")
	}
	var pid int
	if err = store.db.QueryRow("SELECT pg_backend_pid()").Scan(&pid); err != nil {
		t.Fatal(err)
	}
	config, err := pgx.ParseConfig(os.Getenv("PROMPTBENCH_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal("invalid test database configuration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	manager, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		t.Fatal("could not connect test manager")
	}
	defer manager.Close(ctx)
	var terminated bool
	if err = manager.QueryRow(ctx, "SELECT pg_terminate_backend($1)", pid).Scan(&terminated); err != nil || !terminated {
		t.Fatal("could not terminate owned test session", err)
	}
	release <- struct{}{}
	workersDone := make(chan struct{})
	go func() { engine.wg.Wait(); close(workersDone) }()
	select {
	case <-workersDone:
	case <-time.After(10 * time.Second):
		t.Fatal("workers did not stop after database session loss")
	}
	if calls.Load() != 1 {
		t.Fatal("session loss dispatched another provider request")
	}
	for range 2 {
		if _, err = store.state(); err == nil {
			t.Fatal("lost Store silently reconnected")
		}
	}
	if engine.fatal == nil {
		t.Fatal("persistence failure did not latch engine fatal state")
	}
	reopened, err := openStore(target.DSN, target.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.close()
	detail, err := reopened.detail(batch.ID)
	if err != nil || detail.Batch.Status != "interrupted" {
		t.Fatal("new Store did not recover interrupted work", err)
	}
}
