// Enumerate source eligibility with the same compiler's go/build semantics.
// This program does not render documentation or execute the inspected source.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/build"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

var contexts = []string{"linux/amd64", "windows/amd64", "darwin/amd64", "js/wasm"}

type sourcePackage struct {
	PackagePath  string   `json:"packagePath"`
	Context      string   `json:"context"`
	Files        []string `json:"files"`
	Experimental bool     `json:"experimental"`
}
type exclusion struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}
type inventory struct {
	Version     string          `json:"version"`
	Contexts    []string        `json:"contexts"`
	ReleaseTags []string        `json:"releaseTags"`
	ToolTags    []string        `json:"toolTags"`
	CgoEnabled  bool            `json:"cgoEnabled"`
	Packages    []sourcePackage `json:"packages"`
	Excluded    []exclusion     `json:"excluded"`
}

func experiment(importPath string) string {
	switch importPath {
	case "encoding/json/v2", "encoding/json/jsontext":
		return "goexperiment.jsonv2"
	case "runtime/secret":
		return "goexperiment.runtimesecret"
	case "simd", "simd/archsimd":
		return "goexperiment.simd"
	}
	return ""
}

func scan(root string) (inventory, error) {
	result := inventory{Version: runtime.Version(), Contexts: contexts, ReleaseTags: build.Default.ReleaseTags,
		ToolTags: build.Default.ToolTags, CgoEnabled: true, Packages: []sourcePackage{}, Excluded: []exclusion{}}
	stat, err := os.Lstat(root)
	if err != nil {
		return result, err
	}
	if !stat.IsDir() {
		return result, fmt.Errorf("source root must be a real directory")
	}
	directories := map[string][]string{}
	entries := 0
	err = filepath.WalkDir(root, func(file string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		entries++
		if entries > 100000 {
			return fmt.Errorf("source entry limit exceeded")
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("source symlink: %s", file)
		}
		name := entry.Name()
		if entry.IsDir() {
			if file == root {
				return nil
			}
			reason := ""
			switch name {
			case "cmd", "internal", "vendor", "testdata":
				reason = name
			}
			if strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_") {
				reason = "hidden"
			}
			if reason != "" {
				rel, err := filepath.Rel(root, file)
				if err != nil {
					return err
				}
				result.Excluded = append(result.Excluded, exclusion{filepath.ToSlash(rel), reason})
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("nonregular source: %s", file)
		}
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Size() > 16*1024*1024 {
			return fmt.Errorf("source file size limit: %s", file)
		}
		dir := filepath.Dir(file)
		directories[dir] = append(directories[dir], name)
		return nil
	})
	if err != nil {
		return result, err
	}
	dirs := make([]string, 0, len(directories))
	for dir := range directories {
		dirs = append(dirs, dir)
	}
	sort.Strings(dirs)
	for _, dir := range dirs {
		rel, err := filepath.Rel(root, dir)
		if err != nil {
			return result, err
		}
		importPath := filepath.ToSlash(rel)
		for _, context := range contexts {
			parts := strings.Split(context, "/")
			bctx := build.Context{GOOS: parts[0], GOARCH: parts[1], CgoEnabled: true,
				Compiler: build.Default.Compiler, ReleaseTags: build.Default.ReleaseTags,
				ToolTags: append([]string{}, build.Default.ToolTags...)}
			tag := experiment(importPath)
			if tag != "" {
				bctx.ToolTags = append(bctx.ToolTags, tag)
			}
			files := []string{}
			packageName := ""
			for _, name := range directories[dir] {
				match, err := bctx.MatchFile(dir, name)
				if err != nil {
					return result, err
				}
				if !match {
					continue
				}
				parsed, err := parser.ParseFile(token.NewFileSet(), filepath.Join(dir, name), nil, parser.PackageClauseOnly)
				if err != nil {
					return result, err
				}
				if packageName != "" && packageName != parsed.Name.Name {
					return result, fmt.Errorf("conflicting package names: %s %s", importPath, context)
				}
				packageName = parsed.Name.Name
				files = append(files, name)
			}
			if len(files) != 0 {
				if importPath == "." {
					return result, fmt.Errorf("unexpected Go package at src root")
				}
				result.Packages = append(result.Packages, sourcePackage{importPath, context, files, tag != ""})
			}
		}
	}
	return result, nil
}

func main() {
	src := flag.String("src", "", "verified SDK src directory")
	flag.Parse()
	if *src == "" || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "exact -src required")
		os.Exit(1)
	}
	result, err := scan(*src)
	if err == nil {
		err = json.NewEncoder(os.Stdout).Encode(result)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
