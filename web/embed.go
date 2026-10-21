// Package web contains the browser application served by the workbench.
package web

import "embed"

// Assets contains the application shell and its native browser modules.
//
//go:embed index.html js css
var Assets embed.FS
