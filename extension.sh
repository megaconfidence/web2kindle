#!/usr/bin/env bash

#NOTE: if you are on macOS, update to bash v4 i.e brew install bash

rm -rf extension extension.zip
cp -r public extension
cd extension

declare -A scripts0=(
    [file]='tailwind.css'
    [url]='https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css'
)

declare -n scripts
for scripts  in ${!scripts@}; do
  curl ${scripts[url]} -o ${scripts[file]}
  sed -i"" -e "s|${scripts[url]}|${scripts[file]}|g" extension.html
done

zip -r extension.zip *
mv extension.zip ../
