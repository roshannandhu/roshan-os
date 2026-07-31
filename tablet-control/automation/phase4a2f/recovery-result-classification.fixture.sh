#!/system/bin/sh
# Isolated POSIX fixture for the watchdog caller's recovery-result classifier.
# It has no tablet paths, service calls, or persistent side effects.

classify_recovery_result() {
    result=$1
    case "$result" in
        0) printf '%s\n' 'Recovery: SUCCESS' ;;
        '') printf '%s\n' 'Recovery: INVALID_RESULT' ;;
        *[!0-9]*) printf '%s\n' 'Recovery: INVALID_RESULT' ;;
        *) printf '%s\n' 'Recovery: FAILED' ;;
    esac
}

legacy_classify_recovery_result() {
    result=$1
    if [ "$result" -eq ] 2>/dev/null; then
        printf '%s\n' 'Recovery: SUCCESS'
    else
        printf '%s\n' 'Recovery: FAILED'
    fi
}

assert_equal() {
    expected=$1
    actual=$2
    description=$3
    if [ "$actual" != "$expected" ]; then
        printf '%s\n' "FAIL: $description" >&2
        exit 1
    fi
}

mock_success_with_output() {
    printf '%s\n' 'Camera started OK after 9s'
    return 0
}

mock_failure_with_output() {
    printf '%s\n' 'FAILED after 45s'
    return 1
}

# Exact observed defect: a real success return is classified as failure by the
# malformed numeric test with no right-hand operand.
assert_equal 'Recovery: FAILED' "$(legacy_classify_recovery_result 0)" 'legacy empty-operand defect'

assert_equal 'Recovery: SUCCESS' "$(classify_recovery_result 0)" 'explicit success'
assert_equal 'Recovery: FAILED' "$(classify_recovery_result 1)" 'explicit failure'
assert_equal 'Recovery: INVALID_RESULT' "$(classify_recovery_result '')" 'empty value'

unset_value=''
unset unset_value
assert_equal 'Recovery: INVALID_RESULT' "$(classify_recovery_result "${unset_value-}")" 'unset value'
assert_equal 'Recovery: INVALID_RESULT' "$(classify_recovery_result '   ')" 'whitespace-only value'
newline_value='0
'
assert_equal 'Recovery: INVALID_RESULT' "$(classify_recovery_result "$newline_value")" 'newline-terminated value'
cr_value=$(printf '0\r')
assert_equal 'Recovery: INVALID_RESULT' "$(classify_recovery_result "$cr_value")" 'carriage-return value'
assert_equal 'Recovery: INVALID_RESULT' "$(classify_recovery_result 'zero')" 'nonnumeric value'

mock_success_with_output >/dev/null
status=$?
assert_equal 'Recovery: SUCCESS' "$(classify_recovery_result "$status")" 'output mixed with success status'
mock_failure_with_output >/dev/null
status=$?
assert_equal 'Recovery: FAILED' "$(classify_recovery_result "$status")" 'output mixed with failure status'

captured_output=$(mock_success_with_output)
substitution_status=$?
assert_equal 'Recovery: SUCCESS' "$(classify_recovery_result "$substitution_status")" 'command-substitution status'
assert_equal 'Recovery: INVALID_RESULT' "$(classify_recovery_result "$captured_output")" 'command output is not a status value'

recovery_invocations=0
mock_once_failure() {
    recovery_invocations=$((recovery_invocations + 1))
    return 1
}
mock_once_failure
status=$?
assert_equal 'Recovery: FAILED' "$(classify_recovery_result "$status")" 'failure classification'
assert_equal '1' "$recovery_invocations" 'classification does not invoke a second recovery'

printf '%s\n' 'PASS: recovery-result classification fixture'
