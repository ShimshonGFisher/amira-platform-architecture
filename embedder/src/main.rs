//! Amira embedding sidecar.
//!
//! A deliberately tiny service: it loads `bge-small-en-v1.5` once and answers
//! embedding requests over a Unix domain socket. The Bun app talks to it with a
//! plain `fetch` — so our application code stays 100% pure Bun, with zero native
//! ML dependencies. The heavy lifting (ONNX inference) lives here, in the one
//! place where Rust genuinely beats a JS runtime.
//!
//! Routes:
//!   GET  /health  -> "ok"
//!   POST /embed   -> { input: string[] } => { model, dim, embeddings: float[][] }
//!
//! A `/rerank` route is intentionally left for Phase 2 (cross-encoder); the shape
//! of this service makes that a small addition rather than a rewrite.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use serde::{Deserialize, Serialize};
use tokio::net::UnixListener;

const MODEL_NAME: &str = "bge-small-en-v1.5";

#[derive(Clone)]
struct AppState {
    model: Arc<TextEmbedding>,
}

#[derive(Deserialize)]
struct EmbedRequest {
    /// One or more texts to embed in a single call.
    input: Vec<String>,
}

#[derive(Serialize)]
struct EmbedResponse {
    model: &'static str,
    dim: usize,
    /// L2-normalized embeddings (fastembed normalizes BGE output), one per input.
    embeddings: Vec<Vec<f32>>,
}

async fn health() -> &'static str {
    "ok"
}

async fn embed(
    State(state): State<AppState>,
    Json(req): Json<EmbedRequest>,
) -> Result<Json<EmbedResponse>, (StatusCode, String)> {
    if req.input.is_empty() {
        return Ok(Json(EmbedResponse { model: MODEL_NAME, dim: 0, embeddings: vec![] }));
    }

    // Inference is CPU-bound and blocking; keep the async runtime responsive.
    let model = state.model.clone();
    let embeddings = tokio::task::spawn_blocking(move || model.embed(req.input, None))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("join error: {e}")))?
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("embed error: {e}")))?;

    let dim = embeddings.first().map(Vec::len).unwrap_or(0);
    Ok(Json(EmbedResponse { model: MODEL_NAME, dim, embeddings }))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let socket_path =
        std::env::var("EMBED_SOCKET").unwrap_or_else(|_| "/run/amira-embed.sock".to_string());

    eprintln!("[embedder] loading {MODEL_NAME} (first run downloads weights, then cached)…");
    let model = TextEmbedding::try_new(
        InitOptions::new(EmbeddingModel::BGESmallENV15).with_show_download_progress(true),
    )?;
    eprintln!("[embedder] model ready (384-dim)");

    let state = AppState { model: Arc::new(model) };

    let app = Router::new()
        .route("/health", get(health))
        .route("/embed", post(embed))
        .with_state(state);

    // Bind a fresh socket (clear any stale one from a previous run).
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path)?;
    eprintln!("[embedder] listening on unix:{socket_path}");

    axum::serve(listener, app).await?;
    Ok(())
}
