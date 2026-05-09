# Installation

### Published package

After the package is published, install it as a Pi package:

```bash
pi install npm:pi-subflow
```

For one-off testing without adding it to settings:

```bash
pi -e npm:pi-subflow
```

### Local development install

```bash
git clone <repo-url> pi-subflow
cd pi-subflow
npm install
npm run build
pi -e ./dist/extension.js
```

During local development, you can symlink the built extension into Pi's global extension directory:

```bash
ln -sfn "$PWD/dist" ~/.pi/agent/extensions/subflow
```

Run `/reload` in Pi after rebuilding.
