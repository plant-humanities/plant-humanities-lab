# template

Juncture website template

## For local dev

### Using released Juncture scripts

```bash
jekyll serve --disable-disk-cache -d /tmp --config _config.yml,_config.local.yml
```

### Using local Juncture server

A local Juncture server must be running on port 3000 with CORS enabled, for instance:

```bash
npx serve -C
```

```bash
jekyll serve --disable-disk-cache -d /tmp --config _config.yml,_config.local.yml -P 4100
```