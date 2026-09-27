package probe.api;

import java.util.List;

/** Synthetic documentation input; not a subset of the Java platform API.
 * @param <T> payload type
 */
public class Example<T> {
    /** Public constant. */
    public static final int COUNT = 1;

    /** Empty constructor. */
    public Example() {}

    /** Constructor with an array.
     * @param values initial values
     */
    public Example(String[] values) {}

    /** Overload without arguments. */
    public void copy() {}

    /** Overload with qualified types, arrays and varargs.
     * @param values input values
     * @param flags optional flags
     */
    public void copy(List<String> values, int... flags) {}

    /** Generic method.
     * @param <U> input type
     * @param value input value
     * @return the input
     */
    public <U> U identity(U value) { return value; }

    /** Nested type. */
    public static class Nested {
        /** Nested constructor. */
        public Nested() {}
    }

    /** Nested interface. */
    public interface Contract {
        /** Run the operation. */
        void run();
    }

    /** Nested enumeration. */
    public enum Mode {
        /** First mode. */
        FIRST,
        /** Second mode. */
        SECOND
    }

    /** Nested annotation. */
    public @interface Hint {
        /** Annotation value.
         * @return configured text
         */
        String value() default "";
    }

    /** Nested record.
     * @param left left value
     * @param right right value
     */
    public record Pair(int left, String right) {}
}
