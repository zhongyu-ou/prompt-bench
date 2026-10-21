package main

import (
	"log"

	"promptbench/internal/workbench"
)

func main() {
	if err := workbench.Run(); err != nil {
		log.Fatal(err)
	}
}
