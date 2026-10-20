// A local OpenAI-compatible HTTP fixture, not a model or quality evaluator.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	addr := flag.String("listen", "127.0.0.1:9797", "loopback fixture address")
	delay := flag.Duration("delay", 150*time.Millisecond, "response delay for observing progress/stop")
	flag.Parse()
	host, _, err := net.SplitHostPort(*addr)
	ip := net.ParseIP(host)
	if err != nil || ip == nil || !ip.IsLoopback() {
		log.Fatal("fixture requires a numeric loopback listen address")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		defer r.Body.Close()
		var body struct {
			Model    string `json:"model"`
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&body); err != nil {
			http.Error(w, "invalid JSON", 400)
			return
		}
		time.Sleep(*delay)
		w.Header().Set("Content-Type", "application/json")
		authLabel := ""
		if body.Model == "fixture-auth-manual" || body.Model == "fixture-auth-env" {
			env := "PROMPTBENCH_FIXTURE_MANUAL_KEY"
			authLabel = "AUTH MATCH: manual\n"
			if body.Model == "fixture-auth-env" {
				env = "PROMPTBENCH_FIXTURE_ENV_KEY"
				authLabel = "AUTH MATCH: env\n"
			}
			expected := os.Getenv(env)
			if expected == "" {
				http.Error(w, "fixture expected auth is not configured", 500)
				return
			}
			if r.Header.Get("Authorization") != "Bearer "+expected {
				http.Error(w, "fixture auth mismatch (no credential values disclosed)", 401)
				return
			}
		}
		if body.Model == "fixture-http-error" {
			w.WriteHeader(422)
			fmt.Fprint(w, `{"error":{"message":"fixture: unsupported parameter"}}`)
			return
		}
		if body.Model == "fixture-invalid-json" {
			fmt.Fprint(w, `not JSON (fixture)`)
			return
		}
		parts := []string{}
		for _, m := range body.Messages {
			parts = append(parts, m.Role+": "+m.Content)
		}
		json.NewEncoder(w).Encode(map[string]any{"id": "local-fixture", "object": "chat.completion", "model": body.Model + "-fixture-returned", "choices": []any{map[string]any{"index": 0, "message": map[string]string{"role": "assistant", "content": "LOCAL HTTP FIXTURE — not a model response\n" + authLabel + strings.Join(parts, "\n")}, "finish_reason": "stop"}}, "usage": map[string]int{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}})
	})
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("Local fixture http://%s/v1 (no paid calls)", ln.Addr())
	log.Fatal(http.Serve(ln, mux))
}
