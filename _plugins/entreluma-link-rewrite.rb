# frozen_string_literal: true
#
# Rewrite Entreluma shorthand links at build time so crawlers and readers
# without JavaScript never follow them as relative paths.
#
#   [Mesolithic](Q44155)             -> href="https://www.wikidata.org/wiki/Q44155" qid="Q44155"
#   [detail](img1/zoomto/pct:1,2,3,4) -> href="#" data-entreluma-target="img1"
#                                         data-entreluma-action="zoomto"
#                                         data-entreluma-args="pct:1,2,3,4"
#
# Kramdown renders these as relative hrefs, so /cryptomeria linked to /Q44155
# and /posts/guelder-rose/ to /posts/guelder-rose/Q44155, which crawlers
# reported as about a thousand distinct 404s. assets/js/entreluma.js reads the
# qid and data-entreluma-* attributes, so popups and viewer actions still work.

require "nokogiri"

module Entreluma
  module LinkRewrite
    QID = /\A(Q\d+)\z/.freeze
    ACTIONS = %w[zoomto flyto playat].freeze
    ACTION = %r{\A(?:\./)?([\w-]+)/(#{ACTIONS.join("|")})/(.+)\z}.freeze

    module_function

    def rewrite(html)
      return html unless html.include?("href=\"Q") || ACTIONS.any? { |a| html.include?("/#{a}/") }

      doc = Nokogiri::HTML5(html, max_tree_depth: -1)
      changed = false

      doc.css("a[href]").each do |a|
        href = a["href"].to_s.strip
        if (m = QID.match(href))
          a["href"] = "https://www.wikidata.org/wiki/#{m[1]}"
          a["qid"] ||= m[1]
          a["rel"] = [a["rel"], "noopener"].compact.join(" ").strip
          changed = true
        elsif (m = ACTION.match(href))
          a["href"] = "#"
          a["data-entreluma-target"] = m[1]
          a["data-entreluma-action"] = m[2]
          a["data-entreluma-args"] = m[3]
          changed = true
        end
      end

      changed ? doc.to_html : html
    end

    def applies?(doc)
      doc.output_ext == ".html" && doc.output.is_a?(String)
    end
  end
end

# :documents covers posts and the _admin collection (whose guides contain
# examples such as vid1/playat/42,75); :pages covers standalone pages.
Jekyll::Hooks.register [:pages, :documents], :post_render do |doc|
  next unless Entreluma::LinkRewrite.applies?(doc)

  doc.output = Entreluma::LinkRewrite.rewrite(doc.output)
end
