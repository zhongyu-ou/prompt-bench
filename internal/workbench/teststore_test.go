package workbench

import (
	"context"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type testStoreTarget struct {
	DSN     string
	DataDir string
}

func newTestStoreTarget(t *testing.T) testStoreTarget {
	t.Helper()
	dsn := os.Getenv("PROMPTBENCH_TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("PROMPTBENCH_TEST_DATABASE_URL must explicitly name a PostgreSQL test database")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal("invalid test database connection configuration")
	}
	if !strings.HasSuffix(config.Database, "_test") {
		t.Fatal("test database name must end in _test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		t.Fatal("could not connect to PostgreSQL test database")
	}
	schema := "pb_" + newID()
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err = conn.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		conn.Close(ctx)
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		defer conn.Close(ctx)
		if _, err := conn.Exec(ctx, "DROP SCHEMA "+quoted+" CASCADE"); err != nil {
			t.Error(err)
		}
	})
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		uri, err := url.Parse(dsn)
		if err != nil {
			t.Fatal("invalid test database URI")
		}
		query := uri.Query()
		query.Set("search_path", schema)
		uri.RawQuery = query.Encode()
		dsn = uri.String()
	} else {
		dsn += " search_path=" + schema
	}
	return testStoreTarget{DSN: dsn, DataDir: t.TempDir()}
}

func (target testStoreTarget) open(t *testing.T) *Store {
	t.Helper()
	store, err := openStore(target.DSN, target.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.close)
	return store
}
