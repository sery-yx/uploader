FROM --platform=$BUILDPLATFORM rust:1.90-bookworm AS chef
RUN cargo install cargo-chef
WORKDIR /app

FROM chef AS planner
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src && echo "fn main() {}" > src/main.rs
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
ARG TARGETPLATFORM

RUN set -eux; \
    case "${TARGETPLATFORM}" in \
        "linux/arm64") \
            echo "aarch64-unknown-linux-gnu" > /target.txt; \
            DEBIAN_FRONTEND=noninteractive apt-get update && \
            apt-get install -y --no-install-recommends gcc-aarch64-linux-gnu binutils-aarch64-linux-gnu; \
            ;; \
        "linux/amd64") \
            echo "x86_64-unknown-linux-gnu" > /target.txt; \
            ;; \
        *) \
            echo "Unsupported TARGETPLATFORM=${TARGETPLATFORM}" && exit 1; \
            ;; \
    esac
RUN rustup target add "$(cat /target.txt)"

COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --recipe-path recipe.json --target "$(cat /target.txt)" --release

COPY . .
RUN cargo build --release --target "$(cat /target.txt)"
RUN mkdir /output && \
    cp "target/$(cat /target.txt)/release/uploader" /output/uploader && \
    cp -r static /output/static

FROM debian:bookworm-slim AS runtime

WORKDIR /app
COPY --from=builder /output/uploader /usr/local/bin/uploader
COPY --from=builder /output/static ./static
CMD ["/usr/local/bin/uploader"]
