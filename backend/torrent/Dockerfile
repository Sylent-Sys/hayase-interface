FROM golang:1.25-alpine AS builder

ENV GOPROXY=https://proxy.golang.org,direct
ENV GOTOOLCHAIN=auto

WORKDIR /app

# Copy go mod and sum files
COPY go.mod go.sum ./
RUN go mod download

# Copy the source code
COPY *.go ./

# Build the binary
RUN CGO_ENABLED=0 go build -o torrent-srv main.go

FROM alpine:latest
RUN apk --no-cache add ca-certificates

WORKDIR /app
COPY --from=builder /app/torrent-srv .

EXPOSE 5000 6881 6881/udp

CMD ["./torrent-srv"]
