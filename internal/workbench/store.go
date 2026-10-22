package workbench

import (
	"bytes"
	"crypto/cipher"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

var errStale = errors.New("state version is stale; reload before saving")
var errNotFound = errors.New("not found")

type Store struct {
	db           *sql.DB
	lock         *os.File
	mu           sync.Mutex
	secretsMu    sync.Mutex
	aead         cipher.AEAD
	knownSecrets map[string]string
}

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func openStore(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(filepath.Join(filepath.Dir(path), "promptbench.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, fmt.Errorf("data directory is already in use by another Promptbench process: %w", err)
	}
	opened := false
	defer func() {
		if !opened {
			syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
			lock.Close()
		}
	}()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	f.Close()
	if err = os.Chmod(path, 0600); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db, lock: lock}
	_, err = db.Exec(`PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, data BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, summary BLOB NOT NULL, snapshot BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS results (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), seq INTEGER NOT NULL, group_id TEXT NOT NULL, case_id TEXT NOT NULL, iteration INTEGER NOT NULL, data BLOB NOT NULL, UNIQUE(batch_id,group_id,case_id,iteration));
 CREATE TABLE IF NOT EXISTS credentials (ref TEXT PRIMARY KEY, ciphertext BLOB NOT NULL);
 CREATE INDEX IF NOT EXISTS results_batch ON results(batch_id,seq);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	var n int
	err = db.QueryRow("SELECT count(*) FROM state").Scan(&n)
	if err != nil {
		db.Close()
		return nil, err
	}
	if n == 0 {
		state, err := seedState()
		if err != nil {
			db.Close()
			return nil, err
		}
		b, _ := json.Marshal(state)
		_, err = db.Exec("INSERT INTO state VALUES (1,?,?)", state.Version, b)
		if err != nil {
			db.Close()
			return nil, err
		}
	}
	if err = s.initCredentials(filepath.Dir(path)); err != nil {
		db.Close()
		return nil, err
	}
	if err = s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	if err = s.interrupt(); err != nil {
		db.Close()
		return nil, err
	}
	opened = true
	return s, nil
}
func (s *Store) close() {
	s.db.Close()
	syscall.Flock(int(s.lock.Fd()), syscall.LOCK_UN)
	s.lock.Close()
}
func decodeStored(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	return d.Decode(v)
}
func (s *Store) state() (State, error) {
	var b []byte
	var st State
	err := s.db.QueryRow("SELECT data FROM state WHERE id=1").Scan(&b)
	if err == nil {
		err = decodeStored(b, &st)
	}
	if st.Metrics == nil {
		st.Metrics = []Metric{}
	}
	if st.Draft.Metrics == nil {
		st.Draft.Metrics = []MetricSelection{}
	}
	return st, err
}
func (s *Store) saveState(st State, updates map[string]CredentialUpdate) (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveStateLocked(st, updates)
}
func (s *Store) saveStateLocked(st State, updates map[string]CredentialUpdate) (State, error) {
	current, err := s.state()
	if err != nil {
		return st, err
	}
	if current.Version != st.Version {
		return st, errStale
	}
	if err := validateState(st); err != nil {
		return st, err
	}
	existing := make(map[string]Provider, len(current.Providers))
	for _, p := range current.Providers {
		existing[p.ID] = p
	}
	refs := map[string]bool{}
	providers := map[string]Provider{}
	for i := range st.Providers {
		p := &st.Providers[i]
		if old, ok := existing[p.ID]; ok {
			if p.CredentialRef != old.CredentialRef {
				return st, errors.New("existing provider credential_ref cannot be changed")
			}
		} else {
			if p.CredentialRef != "" {
				return st, errors.New("new provider credential_ref must be omitted")
			}
			p.CredentialRef = "cred_" + newID()
		}
		if refs[p.CredentialRef] {
			return st, errors.New("duplicate credential reference")
		}
		refs[p.CredentialRef] = true
		providers[p.ID] = *p
	}
	for id, update := range updates {
		if _, ok := providers[id]; !ok {
			old, existed := existing[id]
			if !existed || update.Action != "clear" {
				return st, errors.New("credential update references an unknown or removed provider")
			}
			providers[id] = old
		}
		switch update.Action {
		case "set":
			if !validCredential(update.Key) {
				return st, errors.New("manual key must be nonblank, without surrounding whitespace/control characters, and at most 16 KiB")
			}
		case "clear":
			if update.Key != "" {
				return st, errors.New("clear credential action must not include a key")
			}
		default:
			return st, errors.New("credential action must be set or clear")
		}
	}
	st.Version++
	b, err := json.Marshal(st)
	if err != nil {
		return st, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return st, err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("UPDATE state SET version=?,data=? WHERE id=1", st.Version, b); err != nil {
		return st, err
	}
	for id, update := range updates {
		ref := providers[id].CredentialRef
		if update.Action == "clear" {
			_, err = tx.Exec("DELETE FROM credentials WHERE ref=?", ref)
		} else {
			var encrypted []byte
			encrypted, err = s.encryptCredential(ref, update.Key)
			if err == nil {
				_, err = tx.Exec("INSERT INTO credentials(ref,ciphertext) VALUES(?,?) ON CONFLICT(ref) DO UPDATE SET ciphertext=excluded.ciphertext", ref, encrypted)
			}
		}
		if err != nil {
			return st, errors.New("could not save encrypted credential")
		}
	}
	if err = tx.Commit(); err != nil {
		return st, err
	}
	for _, update := range updates {
		if update.Action == "set" {
			s.noteSecret(update.Key)
		}
	}
	return st, nil
}
func (s *Store) create(d Detail) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	b, _ := json.Marshal(d.Batch)
	snap, _ := json.Marshal(d.Snapshot)
	if _, err = tx.Exec("INSERT INTO batches VALUES (?,?,?,?)", d.Batch.ID, d.Batch.CreatedAt, b, snap); err != nil {
		return err
	}
	stmt, err := tx.Prepare("INSERT INTO results VALUES (?,?,?,?,?,?,?)")
	if err != nil {
		return err
	}
	defer stmt.Close()
	for i, r := range d.Results {
		b, _ = json.Marshal(r)
		if _, err = stmt.Exec(r.ID, d.Batch.ID, i, r.GroupID, r.CaseID, r.Iteration, b); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (s *Store) update(batch Batch, results ...Result) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	b, _ := json.Marshal(batch)
	if _, err = tx.Exec("UPDATE batches SET summary=? WHERE id=?", b, batch.ID); err != nil {
		return err
	}
	for _, r := range results {
		b, _ = json.Marshal(r)
		if _, err = tx.Exec("UPDATE results SET data=? WHERE id=?", b, r.ID); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (s *Store) list() ([]Batch, error) {
	rows, err := s.db.Query("SELECT summary FROM batches ORDER BY created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Batch{}
	for rows.Next() {
		var b []byte
		var batch Batch
		if err = rows.Scan(&b); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(b, &batch); err != nil {
			return nil, err
		}
		out = append(out, batch)
	}
	return out, rows.Err()
}
func (s *Store) detail(id string) (Detail, error) {
	var d Detail
	var b, snap []byte
	err := s.db.QueryRow("SELECT summary,snapshot FROM batches WHERE id=?", id).Scan(&b, &snap)
	if errors.Is(err, sql.ErrNoRows) {
		return d, errNotFound
	}
	if err != nil {
		return d, err
	}
	if err = json.Unmarshal(b, &d.Batch); err != nil {
		return d, err
	}
	if err = decodeStored(snap, &d.Snapshot); err != nil {
		return d, err
	}
	rows, err := s.db.Query("SELECT data FROM results WHERE batch_id=? ORDER BY seq", id)
	if err != nil {
		return d, err
	}
	defer rows.Close()
	d.Results = []Result{}
	for rows.Next() {
		var r Result
		if err = rows.Scan(&b); err != nil {
			return d, err
		}
		if err = json.Unmarshal(b, &r); err != nil {
			return d, err
		}
		d.Results = append(d.Results, r)
	}
	d.EvaluationSummary = evaluationSummary(d)
	return d, rows.Err()
}
func (s *Store) interrupt() error {
	batches, err := s.list()
	if err != nil {
		return err
	}
	for _, batch := range batches {
		if batch.Status != "running" && batch.Status != "stopping" {
			continue
		}
		d, err := s.detail(batch.ID)
		if err != nil {
			return err
		}
		changed := []Result{}
		for _, r := range d.Results {
			modified := false
			if r.Status == "running" || r.Status == "pending" {
				r.Status = "interrupted"
				r.Error = "server restarted; request may have been sent, outcome unknown; not resent"
				r.FinishedAt = now()
				batch.Interrupted++
				modified = true
			}
			for i := range r.Evaluations {
				o := &r.Evaluations[i]
				if o.Status == "pending" || o.Status == "running" {
					if o.Status == "pending" {
						batch.Evaluation.Pending--
					} else {
						batch.Evaluation.Running--
					}
					o.Status = "interrupted"
					o.Error = "server restarted; metric may have been sent, outcome unknown; not resent"
					o.FinishedAt = now()
					batch.Evaluation.Interrupted++
					modified = true
				}
			}
			if modified {
				changed = append(changed, r)
			}
		}
		batch.Status = "interrupted"
		batch.InFlight = 0
		batch.FinishedAt = now()
		if err = s.update(batch, changed...); err != nil {
			return fmt.Errorf("mark interrupted: %w", err)
		}
	}
	return nil
}
