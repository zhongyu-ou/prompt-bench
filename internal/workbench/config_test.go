package workbench

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTestConfig(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yml")
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestConfigDefaultsAndNestedFields(t *testing.T) {
	cfg, err := loadConfig(writeTestConfig(t, "server: {}\ndatabase: {}\n"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server != (serverConfig{Host: "127.0.0.1", Port: 8787}) || cfg.Database != (databaseConfig{Host: "localhost", Port: 5432, User: "postgres", Name: "promptbench", SSLMode: "disable"}) {
		t.Fatalf("unexpected defaults: server=%+v database host=%q", cfg.Server, cfg.Database.Host)
	}
	cfg, err = loadConfig(writeTestConfig(t, "server:\n  host: '::1'\n  port: 0\ndatabase:\n  host: db.example\n  port: 6543\n  user: bench\n  password: synthetic-secret\n  name: bench_test\n  sslmode: verify-full\n"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server != (serverConfig{Host: "::1", Port: 0}) || cfg.Database != (databaseConfig{Host: "db.example", Port: 6543, User: "bench", Password: "synthetic-secret", Name: "bench_test", SSLMode: "verify-full"}) {
		t.Fatal("nested values were not applied")
	}
	for _, port := range []string{"0", "65535"} {
		if _, err := loadConfig(writeTestConfig(t, "server:\n  port: "+port+"\n")); err != nil {
			t.Fatalf("valid server port %s rejected: %v", port, err)
		}
	}
	for _, port := range []string{"1", "65535"} {
		if _, err := loadConfig(writeTestConfig(t, "database:\n  port: "+port+"\n")); err != nil {
			t.Fatalf("valid database port %s rejected: %v", port, err)
		}
	}
}

func TestConfigRejectsInvalidDocumentsWithoutSecrets(t *testing.T) {
	cases := map[string]string{
		"empty": "", "whitespace": " \n\t", "comment": "# only a comment\n", "null": "null\n", "sequence": "- server\n",
		"invalid syntax":        "database: [synthetic-secret\n",
		"unknown top level":     "synthetic-secret: true\n",
		"unknown nested":        "database:\n  synthetic-secret: true\n",
		"duplicate":             "database:\n  password: synthetic-secret\n  password: other\n",
		"multiple documents":    "server: {}\n---\ndatabase: {}\n",
		"empty second document": "server: {}\n---\n",
		"type":                  "database:\n  port: synthetic-secret\n",
		"server negative port":  "server:\n  port: -1\n", "server large port": "server:\n  port: 65536\n",
		"database zero port": "database:\n  port: 0\n", "database negative port": "database:\n  port: -1\n", "database large port": "database:\n  port: 65536\n",
		"public host": "server:\n  host: 0.0.0.0\n", "empty server host": "server:\n  host: ''\n",
		"empty database host": "database:\n  host: ''\n", "empty user": "database:\n  user: ''\n", "empty name": "database:\n  name: ''\n", "empty sslmode": "database:\n  sslmode: ''\n",
		"whitespace user": "database:\n  user: '  '\n",
		"env file":        "env_file: synthetic-secret\n", "data dir": "data_dir: synthetic-secret\n", "database url": "database_url: synthetic-secret\n",
	}
	for name, text := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := loadConfig(writeTestConfig(t, text))
			if err == nil {
				t.Fatal("invalid configuration accepted")
			}
			if strings.Contains(err.Error(), "synthetic-secret") {
				t.Fatal("configuration error exposed input content")
			}
		})
	}
}

func TestConfigMissingAndUnreadableFiles(t *testing.T) {
	for _, path := range []string{filepath.Join(t.TempDir(), "config", "config.yml"), filepath.Join(t.TempDir(), "explicit.yml")} {
		if _, err := loadConfig(path); err == nil || !strings.Contains(err.Error(), "config/config.example.yml") {
			t.Fatalf("missing configuration must explain how to create it: %v", err)
		}
	}
	if _, err := loadConfig(t.TempDir()); err == nil {
		t.Fatal("directory accepted as readable configuration")
	}
}

func TestConfigConnectionStringEscapesCredentials(t *testing.T) {
	original := databaseConfig{Host: "::1", Port: 5432, User: "user@:/&", Password: "synthetic&secret?@:/%# +", Name: "database /?#", SSLMode: "verify-full"}
	parsed, err := url.Parse(original.connectionString())
	if err != nil {
		t.Fatal("invalid connection URI")
	}
	password, hasPassword := parsed.User.Password()
	if parsed.Scheme != "postgresql" || parsed.Hostname() != original.Host || parsed.Port() != "5432" || parsed.User.Username() != original.User || !hasPassword || password != original.Password || parsed.Path != "/"+original.Name || parsed.Query().Get("sslmode") != original.SSLMode || len(parsed.Query()) != 1 {
		t.Fatal("connection URI did not preserve encoded values")
	}
}
