# pi-document-agent

A terminal AI assistant with a built-in `query_document` tool that can read PDF and Excel files and answer questions about them. Connects to any OpenAI-compatible API endpoint.

## Quick start

### 1. Build the executable

Requirements: [Node.js](https://nodejs.org) ≥ 22.19.

```bash
npm install --ignore-scripts
npm run build:document-agent
```

This produces `packages/coding-agent/dist/pi-document-agent` — a self-contained executable with Node.js embedded (no runtime required on the target machine).

### 2. Configure your endpoint

On first launch, the agent prompts you for:

- **Base URL** — the root URL of your OpenAI-compatible API (e.g. `https://api.openai.com/v1`)
- **API key** — leave empty for local/no-auth endpoints (Ollama, LM Studio, etc.)
- **Model ID** — the model to use (e.g. `gpt-4o`, `llama-3.1-70b`)

This is saved to `~/.pi/models.json` and never asked again. You can also run `/login` at any time inside the agent to add or update the endpoint.

### 3. Run

```bash
./packages/coding-agent/dist/pi-document-agent
```

Or copy it anywhere on your `PATH`:

```bash
cp packages/coding-agent/dist/pi-document-agent /usr/local/bin/pi-document-agent
pi-document-agent
```

## Using the document tool

Once inside the agent, ask it to read a file:

```
Query the document at /path/to/report.pdf — what are the key findings?
```

```
Summarize the data in /path/to/budget.xlsx
```

Supported formats: `.pdf`, `.xlsx`, `.xls`

The agent extracts the document text locally and sends it to the model along with your question — no third-party document processing service is involved.

## models.json reference

Configuration lives at `~/.pi/models.json`:

```json
{
  "providers": {
    "default": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "api": "openai-completions",
      "models": [
        {
          "id": "gpt-4o",
          "name": "gpt-4o",
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

You can define multiple providers and models. Use `/model` inside the agent to switch between them.

## Slash commands

| Command | Description |
|---|---|
| `/login` | Add or update a provider (writes to models.json) |
| `/model` | Switch the active model |
| `/new` | Start a fresh session |
| `/session` | Show session stats and token usage |
| `/compact` | Summarise context to free up tokens |
| `/export` | Export the session as HTML or JSONL |
| `/quit` | Exit |

## Development

### Project structure

```
packages/
  tui/          Terminal UI library
  ai/           OpenAI-compatible API client (single provider: openai-completions)
  agent/        Agent runtime and tool loop
  coding-agent/ CLI, interactive mode, all slash commands
    examples/extensions/document-agent/   Document Q&A extension (baked into the binary)
```

### Run from source

```bash
npm install --ignore-scripts
./pi-test.sh          # runs pi from source (no build needed)
```

### Check

```bash
npm run check         # lint + type-check + shrinkwrap validation
```

### Build the binary

```bash
npm run build:document-agent   # runs in packages/coding-agent/
```

Output: `packages/coding-agent/dist/pi-document-agent`

### Adding models

Models are not built in. Add them to `~/.pi/models.json` or use `/login` inside the running agent.

### Extending the document tool

The document agent extension lives at `packages/coding-agent/examples/extensions/document-agent/index.ts`. It registers a `query_document` tool that:

1. Parses the file locally (PDF via `unpdf`, Excel via `xlsx`)
2. Runs a sub-agent with the document text as system context and no other tools
3. Returns the answer

To add more file formats or change the sub-agent behaviour, edit `index.ts` and rebuild.
