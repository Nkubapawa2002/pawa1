// Pawa "java" service stub.
//
// Role in the polyglot stack: enterprise integrations & money — payment /
// settlement processing, bank & mobile-money SDKs, formal accounting/ledger
// logic, anything with mature Java SDKs, and a future Android app.
// See ../../docs/LANGUAGE-ROUTING.md.
//
// Dependency-free: uses only the JDK (com.sun.net.httpserver). No Maven/Gradle
// needed. Run directly with JDK 21+ single-file launch:  java Health.java
import com.sun.net.httpserver.HttpServer;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

public class Health {
    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8093"));
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/health", exchange -> {
            byte[] body = "{\"lang\":\"java\",\"status\":\"ok\",\"role\":\"enterprise / payments / accounting\"}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(body);
            }
        });
        server.start();
        System.out.println("java service listening on http://127.0.0.1:" + port + "/health");
    }
}
