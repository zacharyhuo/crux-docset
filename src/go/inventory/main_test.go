package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInventoryUsesTargetConstraintsAndRecordsExclusions(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		"builtin/builtin.go":         "package builtin\n",
		"unsafe/unsafe.go":           "package unsafe\n",
		"fixture/common.go":          "package fixture\n",
		"fixture/windows_windows.go": "package fixture\n",
		"fixture/ignored_test.go":    "package fixture\n",
		"syscall/js/js.go":           "//go:build js && wasm\n\npackage js\n",
		"encoding/json/v2/doc.go":    "//go:build goexperiment.jsonv2\n\npackage json\n",
		"unrelated/doc.go":           "//go:build goexperiment.simd\n\npackage unrelated\n",
		"internal/hidden/a.go":       "package hidden\n",
		"cmd/tool/a.go":              "package main\n",
		"vendor/foo/a.go":            "package foo\n",
		"fixture/testdata/a.go":      "package fixture\n",
	}
	for name, content := range files {
		file := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	result, err := scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Excluded) != 4 {
		t.Fatalf("excluded: %+v", result.Excluded)
	}
	js := 0
	for _, p := range result.Packages {
		if p.PackagePath == "unrelated" {
			t.Fatal("experiment tag leaked")
		}
		if p.PackagePath == "syscall/js" {
			js++
			if p.Context != "js/wasm" {
				t.Fatal(p)
			}
		}
		if p.PackagePath == "encoding/json/v2" && !p.Experimental {
			t.Fatal("unlabelled experimental package")
		}
		if p.PackagePath == "fixture" {
			want := 1
			if p.Context == "windows/amd64" {
				want = 2
			}
			if len(p.Files) != want {
				t.Fatalf("wrong files: %+v", p)
			}
		}
	}
	if js != 1 {
		t.Fatalf("js entries: %d", js)
	}
}

func TestInventoryRejectsSymlinksAndMalformedBuildTags(t *testing.T) {
	root := t.TempDir()
	if err := os.Symlink(t.TempDir(), filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	if _, err := scan(root); err == nil {
		t.Fatal("accepted symlink")
	}
	root = t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "bad.go"), []byte("//go:build (\n\npackage bad\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := scan(root); err == nil {
		t.Fatal("accepted bad constraints")
	}
}
