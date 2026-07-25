package ai.memnox;

/** The seam. Tests drive real client logic against a fake; production uses HTTP. */
public interface Transport {
    Response post(String url, String token, String body);

    /** A 4xx or 5xx is an answer, not a transport failure — they stay distinct. */
    record Response(int status, String body) {}
}
