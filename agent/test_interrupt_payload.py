"""Unit tests for LiveKit interrupt data-channel contract."""
import json
from interrupt_payload import parse_interrupt_data_payload


def test_interrupt_dict():
    assert parse_interrupt_data_payload({"type": "interrupt"}) is True


def test_interrupt_bytes_json():
    assert parse_interrupt_data_payload(json.dumps({"type": "interrupt"}).encode()) is True


def test_non_interrupt_ignored():
    assert parse_interrupt_data_payload({"type": "hello"}) is False
    assert parse_interrupt_data_payload(b"not-json") is False
    assert parse_interrupt_data_payload(None) is False


if __name__ == "__main__":
    test_interrupt_dict()
    test_interrupt_bytes_json()
    test_non_interrupt_ignored()
    print("agent interrupt tests OK")
