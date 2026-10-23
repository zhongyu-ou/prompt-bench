FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
COPY internal/ ./internal/
COPY web/ ./web/
RUN CGO_ENABLED=0 go build -trimpath -o /out/promptbench .

FROM alpine:3.22 AS runtime
RUN apk add --no-cache ca-certificates wget \
    && addgroup -g 10001 app \
    && adduser -D -H -u 10001 -G app app \
    && mkdir -p /etc/promptbench /var/lib/promptbench \
    && chown app:app /var/lib/promptbench \
    && chmod 0700 /var/lib/promptbench
COPY --from=build /out/promptbench /usr/local/bin/promptbench
USER 10001:10001
WORKDIR /var/lib/promptbench
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8787/api/health || exit 1
ENTRYPOINT ["/usr/local/bin/promptbench"]
CMD ["-config", "/etc/promptbench/config.yml", "-listen", "127.0.0.1:8787", "-data-dir", "/var/lib/promptbench"]
