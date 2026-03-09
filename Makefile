.PHONY: help build pack clean

help:
	@echo ""
	@echo "  build    — compile TypeScript"
	@echo "  pack     — build + create npm tarball"
	@echo "  clean    — remove build artifacts and tarball"
	@echo ""

# ── Build ──────────────────────────────────────────────────────────────────────

build: clean
	npm run build

pack: build
	npm pack

# ── Clean ──────────────────────────────────────────────────────────────────────

clean:
	rm -rf dist $(TARBALL)
