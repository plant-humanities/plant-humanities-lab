# Plant Humanities Lab

The Plant Humanities Lab publishes interdisciplinary stories about plants and their relationships with human culture. The site is built with Jekyll and the [Entreluma](https://github.com/rsnyder/entreluma) interactive-story framework.

Production site: [lab.plant-humanities.org](https://lab.plant-humanities.org)

## Local development

Use the Ruby version in `.ruby-version` and Bundler:

```sh
bundle install
bundle exec jekyll serve --livereload
```

Open `http://127.0.0.1:4000`.

## Syncing Entreluma core

Check for changes to reusable framework files without modifying this repository:

```sh
python3 tools/sync_code.py --check
```

After reviewing the affected paths, apply the update and run the tests below:

```sh
python3 tools/sync_code.py --apply
```

PHL configuration, stories, media, branding, and local documentation are not overwritten. See [Syncing Entreluma template copies](docs/upstream-sync.md) for the exact boundary and options for pinned revisions or a local Entreluma checkout.

## Tests

Run the same core checks used by the Entreluma template:

```sh
python3 tools/check_consistency.py
bundle exec ruby tools/prove_local_media.rb
JEKYLL_ENV=production bundle exec jekyll build
bundle exec htmlproofer _site \
  --disable-external \
  --no-enforce-https \
  --ignore-files "/assets\\/components\\//" \
  --ignore-urls "/^Q[0-9]+$/,/\\/(zoomto|flyto|playat|play|pause)\\//,/^http:\\/\\/127\\.0\\.0\\.1/,/^http:\\/\\/0\\.0\\.0\\.0/,/^http:\\/\\/localhost/"
```

The deployment workflow builds and tests the site on GitHub Pages. PHL-specific stories, media, branding, analytics, and homepage content remain in this repository; reusable publishing code comes from Entreluma.
