# frozen_string_literal: true

source "https://rubygems.org"

# Pinned EXACTLY, not "~> 7.4". preview/index.html hardcodes CHIRPY_VERSION and
# fetches theme files from jsDelivr at that tag, so the gem and that constant
# have to agree. A range let any repo without a committed Gemfile.lock resolve
# whatever 7.x was newest at build time and fail check_consistency the moment
# upstream released one (7.6.0 did exactly that to plant-humanities-lab, whose
# .gitignore excludes Gemfile.lock, so CI resolved fresh every build).
# Upgrading is deliberate: bump here AND CHIRPY_VERSION in preview/index.html,
# then re-record the CDN fixtures and regenerate the render goldens.
gem "jekyll-theme-chirpy", "= 7.5.0"

gem "html-proofer", "~> 5.0", group: :test

platforms :mingw, :x64_mingw, :mswin, :jruby do
  gem "tzinfo", ">= 1", "< 3"
  gem "tzinfo-data"
end

gem "wdm", "~> 0.2.0", :platforms => [:mingw, :x64_mingw, :mswin]
