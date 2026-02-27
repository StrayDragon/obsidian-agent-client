set shell := ["sh", "-cu"]

plugin_id := shell("node -p \"require('./manifest.json').id\"")
dist_dir := "dist/" + plugin_id
vault_default := env_var_or_default("OBSIDIAN_VAULT", "")

default:
	@just --list

deps:
	if [ ! -d node_modules ]; then \
		if npm ci; then \
			: ; \
		else \
			echo "npm ci failed (package-lock.json out of sync). Falling back to: npm install --no-package-lock" ; \
			npm install --no-package-lock ; \
		fi ; \
	fi

build: deps
	npm run build

dev: deps
	npm run dev

# Create a self-contained plugin folder under `dist/`
package out=dist_dir: build
	rm -rf "{{out}}"
	mkdir -p "{{out}}"
	cp -f manifest.json styles.css main.js "{{out}}/"
	@echo "Packaged to: {{out}}"

# Copy build outputs into an Obsidian vault plugin directory for quick testing
install vault=vault_default: build
	if [ -z "{{vault}}" ]; then echo "Usage: just install /path/to/vault  (or set OBSIDIAN_VAULT)"; exit 2; fi
	mkdir -p "{{vault}}/.obsidian/plugins/{{plugin_id}}"
	cp -f manifest.json styles.css main.js "{{vault}}/.obsidian/plugins/{{plugin_id}}/"
	@echo "Installed to: {{vault}}/.obsidian/plugins/{{plugin_id}}"

# Symlink build outputs into an Obsidian vault plugin directory (Linux/macOS)
link vault=vault_default:
	if [ -z "{{vault}}" ]; then echo "Usage: just link /path/to/vault  (or set OBSIDIAN_VAULT)"; exit 2; fi
	mkdir -p "{{vault}}/.obsidian/plugins/{{plugin_id}}"
	ln -sf "$(pwd)/manifest.json" "{{vault}}/.obsidian/plugins/{{plugin_id}}/manifest.json"
	ln -sf "$(pwd)/styles.css" "{{vault}}/.obsidian/plugins/{{plugin_id}}/styles.css"
	ln -sf "$(pwd)/main.js" "{{vault}}/.obsidian/plugins/{{plugin_id}}/main.js"
	@echo "Linked to: {{vault}}/.obsidian/plugins/{{plugin_id}}"

where vault=vault_default:
	if [ -z "{{vault}}" ]; then echo "Usage: just where /path/to/vault  (or set OBSIDIAN_VAULT)"; exit 2; fi
	@echo "{{vault}}/.obsidian/plugins/{{plugin_id}}"
