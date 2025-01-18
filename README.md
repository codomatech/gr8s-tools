# gr8s-tools

A set of tools and utilities to support the operation of [gr8s server](https://gr8s-server.codoma.tech/).

## `gr8s-cli`

```
Usage: gr8s-cli [options]

A command to prepare your html code to use with gr8s server. For more details, check:
    https://gr8s-server.codoma.tech

Options:
  -f, --index <char>         the path of the site index.html. If not provided, it will be guessed
  -rc, --js_remove_contents  add JS code to remove pre-rendered content on page load
  --signup                   create a quick account on s3 cloud
  -rl, --js_remove_links     add JS code to remove pre-rendered links on page load
  -m                         switch on minifying the output html
  --deploy                   deploy frontend assets to gr8s cloud. More info at https://s3.app.codoma.tech/
  -v, --verbose              switch on verbose output
  -h, --help                 display help for command

```
