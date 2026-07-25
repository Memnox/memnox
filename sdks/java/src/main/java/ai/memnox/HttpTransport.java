package ai.memnox;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/** JDK-only HTTP. No third-party client, so no version conflicts to resolve. */
public final class HttpTransport implements Transport {
    private final HttpClient client;
    private final Duration timeout;

    public HttpTransport() {
        this(Duration.ofSeconds(10));
    }

    public HttpTransport(Duration timeout) {
        this.timeout = timeout;
        this.client = HttpClient.newBuilder().connectTimeout(timeout).build();
    }

    @Override
    public Response post(String url, String token, String body) {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(timeout)
                .header("authorization", "Bearer " + token)
                .header("content-type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        try {
            HttpResponse<String> response =
                    client.send(request, HttpResponse.BodyHandlers.ofString());
            return new Response(response.statusCode(), response.body());
        } catch (IOException err) {
            throw new MemnoxException.Transport(err.getMessage(), err);
        } catch (InterruptedException err) {
            Thread.currentThread().interrupt();
            throw new MemnoxException.Transport("interrupted", err);
        }
    }
}
