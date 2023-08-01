FROM --platform=linux/x86_64 golang:1.20.6

WORKDIR /app
COPY main.go /app
COPY go.mod /app
RUN go build -o main .

ENTRYPOINT ["/app/main"]
