package workbench

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
)

type appConfig struct {
	Server   serverConfig   `yaml:"server"`
	Database databaseConfig `yaml:"database"`
}

type serverConfig struct {
	Host string `yaml:"host"`
	Port int    `yaml:"port"`
}

type databaseConfig struct {
	Host     string `yaml:"host"`
	Port     int    `yaml:"port"`
	User     string `yaml:"user"`
	Password string `yaml:"password"`
	Name     string `yaml:"name"`
	SSLMode  string `yaml:"sslmode"`
}

func loadConfig(path string) (appConfig, error) {
	cfg := appConfig{
		Server:   serverConfig{Host: "127.0.0.1", Port: 8787},
		Database: databaseConfig{Host: "localhost", Port: 5432, User: "postgres", Name: "promptbench", SSLMode: "disable"},
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return appConfig{}, errors.New("configuration file not found; create it from config/config.example.yml (or select one with --config)")
		}
		return appConfig{}, errors.New("cannot read configuration file")
	}
	// Inspect the document shape without returning parser errors, which can quote secrets.
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil || len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return appConfig{}, errors.New("configuration must be a non-empty YAML mapping")
	}
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)
	if err := decoder.Decode(&cfg); err != nil {
		return appConfig{}, errors.New("invalid configuration YAML: check field names, types, and duplicate keys")
	}
	var extra yaml.Node
	if err := decoder.Decode(&extra); err != io.EOF {
		return appConfig{}, errors.New("configuration must contain exactly one YAML document")
	}
	if cfg.Server.Port < 0 || cfg.Server.Port > 65535 {
		return appConfig{}, errors.New("server.port must be between 0 and 65535")
	}
	if _, err := loopbackAddress(net.JoinHostPort(cfg.Server.Host, strconv.Itoa(cfg.Server.Port))); err != nil {
		return appConfig{}, errors.New("server.host must be a loopback address (127.0.0.1, ::1, or localhost)")
	}
	if cfg.Database.Port < 1 || cfg.Database.Port > 65535 {
		return appConfig{}, errors.New("database.port must be between 1 and 65535")
	}
	for _, field := range []struct{ name, value string }{
		{"host", cfg.Database.Host}, {"user", cfg.Database.User}, {"name", cfg.Database.Name}, {"sslmode", cfg.Database.SSLMode},
	} {
		if strings.TrimSpace(field.value) == "" {
			return appConfig{}, fmt.Errorf("database.%s must not be empty", field.name)
		}
	}
	return cfg, nil
}

func (c databaseConfig) connectionString() string {
	query := url.Values{"sslmode": {c.SSLMode}}
	return (&url.URL{
		Scheme:   "postgresql",
		User:     url.UserPassword(c.User, c.Password),
		Host:     net.JoinHostPort(c.Host, strconv.Itoa(c.Port)),
		Path:     "/" + c.Name,
		RawQuery: query.Encode(),
	}).String()
}
