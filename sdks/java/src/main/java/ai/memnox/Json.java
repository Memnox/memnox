package ai.memnox;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A small recursive-descent JSON reader and writer. Present so the SDK carries
 * no dependencies; it handles the shapes this API exchanges and nothing more.
 */
final class Json {
    private final String source;
    private int index;

    private Json(String source) {
        this.source = source;
    }

    static Object parse(String source) {
        Json reader = new Json(source);
        reader.skipWhitespace();
        Object value = reader.readValue();
        reader.skipWhitespace();
        if (reader.index < source.length()) {
            throw new IllegalArgumentException("trailing content at " + reader.index);
        }
        return value;
    }

    /** Serialises a flat map, omitting null values so unset fields never ship. */
    static String writeObject(Map<String, Object> fields) {
        StringBuilder out = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Object> entry : fields.entrySet()) {
            if (entry.getValue() == null) continue;
            if (!first) out.append(',');
            first = false;
            writeString(out, entry.getKey());
            out.append(':');
            writeValue(out, entry.getValue());
        }
        return out.append('}').toString();
    }

    private static void writeValue(StringBuilder out, Object value) {
        if (value instanceof String text) writeString(out, text);
        else if (value instanceof Number || value instanceof Boolean) out.append(value);
        else writeString(out, String.valueOf(value));
    }

    private static void writeString(StringBuilder out, String text) {
        out.append('"');
        for (int i = 0; i < text.length(); i++) {
            char character = text.charAt(i);
            switch (character) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (character < 0x20) out.append(String.format("\\u%04x", (int) character));
                    else out.append(character);
                }
            }
        }
        out.append('"');
    }

    private Object readValue() {
        char character = peek();
        return switch (character) {
            case '{' -> readObject();
            case '[' -> readArray();
            case '"' -> readString();
            case 't', 'f' -> readBoolean();
            case 'n' -> readNull();
            default -> readNumber();
        };
    }

    private Map<String, Object> readObject() {
        Map<String, Object> map = new LinkedHashMap<>();
        expect('{');
        skipWhitespace();
        if (peek() == '}') {
            index++;
            return map;
        }
        while (true) {
            skipWhitespace();
            String key = readString();
            skipWhitespace();
            expect(':');
            skipWhitespace();
            map.put(key, readValue());
            skipWhitespace();
            char next = next();
            if (next == '}') return map;
            if (next != ',') throw new IllegalArgumentException("expected , or } at " + index);
        }
    }

    private List<Object> readArray() {
        List<Object> items = new ArrayList<>();
        expect('[');
        skipWhitespace();
        if (peek() == ']') {
            index++;
            return items;
        }
        while (true) {
            skipWhitespace();
            items.add(readValue());
            skipWhitespace();
            char next = next();
            if (next == ']') return items;
            if (next != ',') throw new IllegalArgumentException("expected , or ] at " + index);
        }
    }

    private String readString() {
        expect('"');
        StringBuilder out = new StringBuilder();
        while (true) {
            char character = next();
            if (character == '"') return out.toString();
            if (character != '\\') {
                out.append(character);
                continue;
            }
            char escape = next();
            switch (escape) {
                case '"' -> out.append('"');
                case '\\' -> out.append('\\');
                case '/' -> out.append('/');
                case 'b' -> out.append('\b');
                case 'f' -> out.append('\f');
                case 'n' -> out.append('\n');
                case 'r' -> out.append('\r');
                case 't' -> out.append('\t');
                case 'u' -> {
                    out.append((char) Integer.parseInt(source.substring(index, index + 4), 16));
                    index += 4;
                }
                default -> throw new IllegalArgumentException("bad escape at " + index);
            }
        }
    }

    private Boolean readBoolean() {
        if (source.startsWith("true", index)) {
            index += 4;
            return Boolean.TRUE;
        }
        if (source.startsWith("false", index)) {
            index += 5;
            return Boolean.FALSE;
        }
        throw new IllegalArgumentException("bad literal at " + index);
    }

    private Object readNull() {
        if (!source.startsWith("null", index)) {
            throw new IllegalArgumentException("bad literal at " + index);
        }
        index += 4;
        return null;
    }

    private Double readNumber() {
        int start = index;
        while (index < source.length() && "+-.eE0123456789".indexOf(source.charAt(index)) >= 0) {
            index++;
        }
        if (start == index) throw new IllegalArgumentException("bad number at " + index);
        return Double.valueOf(source.substring(start, index));
    }

    private void skipWhitespace() {
        while (index < source.length() && Character.isWhitespace(source.charAt(index))) index++;
    }

    private char peek() {
        if (index >= source.length()) throw new IllegalArgumentException("unexpected end");
        return source.charAt(index);
    }

    private char next() {
        char character = peek();
        index++;
        return character;
    }

    private void expect(char character) {
        if (next() != character) {
            throw new IllegalArgumentException("expected " + character + " at " + index);
        }
    }
}
