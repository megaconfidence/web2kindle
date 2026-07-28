#!/usr/bin/env bash

#NOTE: if you are on macOS, update to bash v4 i.e brew install bash

rm -rf extension extension.zip
cp -r public extension
cd extension

# macOS sprinkles these through the tree and they would otherwise ship to the stores.
find . -name '.DS_Store' -delete

declare -A scripts0=(
    [file]='tailwind.css'
    [url]='https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css'
)

declare -n scripts
for scripts  in ${!scripts@}; do
  # Fail the build rather than packaging an error page as the stylesheet.
  curl -fsSL "${scripts[url]}" -o "${scripts[file]}"
  # Written through a temp file because BSD and GNU sed disagree about in-place editing,
  # which used to leave an "extension.html-e" backup inside the published zip.
  sed "s|${scripts[url]}|${scripts[file]}|g" extension.html > extension.html.tmp
  mv extension.html.tmp extension.html
done

zip -r extension.zip *
mv extension.zip ../
