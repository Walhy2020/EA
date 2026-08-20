# Module Contract

Every business module should expose a small async interface:

```js
{
  name: "rank",
  async handle(context) {},
  async getStatus() {}
}
```

`context`:

```js
{
  text: "user message",
  intent: "rank.query",
  sender: {},
  raw: {}
}
```

`handle` returns:

```js
{
  ok: true,
  module: "rank",
  intent: "rank.query",
  text: "reply text",
  data: {}
}
```

Modules must not log secrets, raw webhook URLs, API keys, or access tokens.
