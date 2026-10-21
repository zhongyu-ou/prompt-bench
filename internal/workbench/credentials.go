package workbench

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

func validCredential(key string) bool {
	if key == "" || len(key) > 16384 || strings.TrimSpace(key) != key {
		return false
	}
	for _, r := range key {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
func (s *Store) initCredentials(dir string) error {
	var count int
	if err := s.db.QueryRow("SELECT count(*) FROM credentials").Scan(&count); err != nil {
		return err
	}
	path := filepath.Join(dir, "credentials.key")
	master, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if count > 0 {
			return errors.New("credentials.key is missing while encrypted credentials exist; restore the original keyfile with the database")
		}
		master = make([]byte, 32)
		if _, err = rand.Read(master); err != nil {
			return err
		}
		f, openErr := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if openErr != nil {
			return errors.New("cannot create credentials.key")
		}
		_, err = f.Write(master)
		if err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err != nil || closeErr != nil {
			return errors.New("cannot persist credentials.key")
		}
	} else if err != nil {
		return errors.New("cannot read credentials.key")
	}
	if len(master) != 32 {
		return errors.New("invalid credentials.key; restore the original 32-byte keyfile")
	}
	if err = os.Chmod(path, 0600); err != nil {
		return errors.New("cannot restrict credentials.key permissions")
	}
	block, err := aes.NewCipher(master)
	if err != nil {
		return errors.New("invalid credential encryption key")
	}
	s.aead, err = cipher.NewGCM(block)
	if err != nil {
		return err
	}
	s.knownSecrets = map[string]string{}
	rows, err := s.db.Query("SELECT ref,ciphertext FROM credentials")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var ref string
		var encrypted []byte
		if err = rows.Scan(&ref, &encrypted); err != nil {
			return err
		}
		key, err := s.decryptCredential(ref, encrypted)
		if err != nil {
			return errors.New("encrypted credentials cannot be decrypted; restore matching database and credentials.key")
		}
		s.noteSecret(key)
	}
	return rows.Err()
}
func (s *Store) encryptCredential(ref, key string) ([]byte, error) {
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return s.aead.Seal(nonce, nonce, []byte(key), []byte(ref)), nil
}
func (s *Store) decryptCredential(ref string, encrypted []byte) (string, error) {
	n := s.aead.NonceSize()
	if len(encrypted) < n {
		return "", errors.New("invalid encrypted credential")
	}
	plain, err := s.aead.Open(nil, encrypted[:n], encrypted[n:], []byte(ref))
	if err != nil {
		return "", errors.New("invalid encrypted credential")
	}
	return string(plain), nil
}
func (s *Store) manualCredential(ref string) (string, bool, error) {
	var encrypted []byte
	err := s.db.QueryRow("SELECT ciphertext FROM credentials WHERE ref=?", ref).Scan(&encrypted)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, errors.New("cannot read encrypted credential")
	}
	key, err := s.decryptCredential(ref, encrypted)
	return key, true, err
}
func (s *Store) noteSecret(key string) {
	if key == "" {
		return
	}
	s.secretsMu.Lock()
	s.knownSecrets[key] = key
	s.secretsMu.Unlock()
}
func (s *Store) sensitiveValues() map[string]string {
	s.secretsMu.Lock()
	defer s.secretsMu.Unlock()
	out := make(map[string]string, len(s.knownSecrets))
	for k, v := range s.knownSecrets {
		out[k] = v
	}
	return out
}
func (s *Store) credential(ref, env string, required bool, getenv func(string) string) (string, CredentialStatus, error) {
	manual, exists, err := s.manualCredential(ref)
	envKey := ""
	if env != "" {
		envKey = getenv(env)
		s.noteSecret(envKey)
	}
	status := CredentialStatus{ManualSet: exists, EnvAvailable: validCredential(envKey), RequiresAuth: required || exists || env != ""}
	if err != nil {
		status.Source = "invalid"
		return "", status, errors.New("encrypted credential is unavailable; restore matching database and credentials.key")
	}
	if exists {
		status.Source = "manual"
		if !validCredential(manual) {
			status.Source = "invalid"
			return "", status, errors.New("stored manual credential is invalid")
		}
		s.noteSecret(manual)
		status.Available = true
		return manual, status, nil
	}
	if envKey != "" {
		status.Source = "env"
		if !validCredential(envKey) {
			status.Source = "invalid"
			return "", status, errors.New("environment credential is invalid")
		}
		status.Available = true
		return envKey, status, nil
	}
	if status.RequiresAuth {
		status.Source = "missing"
		return "", status, fmt.Errorf("required credential is missing for reference %s", ref)
	}
	status.Source = "anonymous"
	status.Available = true
	return "", status, nil
}
func (s *Store) credentialStatuses(st State, getenv func(string) string) map[string]CredentialStatus {
	out := make(map[string]CredentialStatus, len(st.Providers))
	for _, p := range st.Providers {
		_, status, _ := s.credential(p.CredentialRef, p.APIKeyEnv, false, getenv)
		out[p.ID] = status
	}
	return out
}
