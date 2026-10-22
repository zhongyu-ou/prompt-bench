package workbench

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func loadEnvFile(path string) error {
	if path == "" {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	line := 0
	for scanner.Scan() {
		line++
		text := strings.TrimSpace(scanner.Text())
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		text = strings.TrimPrefix(text, "export ")
		key, value, ok := strings.Cut(text, "=")
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if !ok || !envName.MatchString(key) {
			return fmt.Errorf("env-file line %d: expected NAME=value", line)
		}
		if len(value) > 0 && (value[0] == '\'' || value[0] == '"') {
			quote := value[0]
			if len(value) < 2 || value[len(value)-1] != quote {
				return fmt.Errorf("env-file line %d: unmatched quote", line)
			}
			if quote == '"' {
				value, err = strconv.Unquote(value)
				if err != nil {
					return fmt.Errorf("env-file line %d: invalid quoted value", line)
				}
			} else {
				value = value[1 : len(value)-1]
			}
		}
		if _, exists := os.LookupEnv(key); !exists {
			if err = os.Setenv(key, value); err != nil {
				return fmt.Errorf("env-file line %d: invalid environment value", line)
			}
		}
	}
	return scanner.Err()
}
func loopbackAddress(addr string) (string, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "", fmt.Errorf("listen must be a loopback host:port: %w", err)
	}
	if host == "localhost" {
		host = "127.0.0.1"
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return "", errors.New("public bind rejected: listen host must be 127.0.0.1, ::1, or localhost")
	}
	if _, err = strconv.ParseUint(port, 10, 16); err != nil {
		return "", errors.New("invalid listen port")
	}
	return net.JoinHostPort(host, port), nil
}

// Run starts the loopback HTTP workbench and blocks until it shuts down.
func Run() error {
	flags := flag.NewFlagSet("promptbench", flag.ContinueOnError)
	configPath := flags.String("config", "config/config.yml", "service YAML configuration file")
	addr := flags.String("listen", "", "override loopback listen address (public bind forbidden)")
	dir := flags.String("data-dir", "database", "private credentials key directory")
	envFile := flags.String("env-file", "", "optional NAME=value file; existing environment wins")
	if err := flags.Parse(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	listenAddress := net.JoinHostPort(cfg.Server.Host, strconv.Itoa(cfg.Server.Port))
	flags.Visit(func(f *flag.Flag) {
		if f.Name == "listen" {
			listenAddress = *addr
		}
	})
	listen, err := loopbackAddress(listenAddress)
	if err != nil {
		return err
	}
	if err = loadEnvFile(*envFile); err != nil {
		return err
	}
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		return err
	}
	defer ln.Close()
	store, err := openStore(cfg.Database.connectionString(), *dir)
	if err != nil {
		return fmt.Errorf("open data: %w", err)
	}
	defer store.close()
	engine := newEngine(store, os.Getenv)
	defer engine.close()
	server := &http.Server{Handler: newAPI(store, engine, ln.Addr().String()), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		<-signals
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(ctx)
	}()
	log.Printf("Promptbench http://%s (PostgreSQL)", ln.Addr())
	err = server.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
