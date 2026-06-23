#!/usr/bin/env python3
"""Tests for predicate DSL engine (_eval_predicate)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[3]))

from plugins.the_daily.routes import _eval_predicate


class TestYearBetween(unittest.TestCase):
    def test_within_range(self):
        song = {"year": 1985}
        pred = {"op": "year_between", "min": 1980, "max": 1990}
        self.assertTrue(_eval_predicate(song, pred))

    def test_below_min(self):
        song = {"year": 1979}
        pred = {"op": "year_between", "min": 1980, "max": 1990}
        self.assertFalse(_eval_predicate(song, pred))

    def test_above_max(self):
        song = {"year": 1991}
        pred = {"op": "year_between", "min": 1980, "max": 1990}
        self.assertFalse(_eval_predicate(song, pred))

    def test_exact_min(self):
        song = {"year": 1980}
        pred = {"op": "year_between", "min": 1980, "max": 1990}
        self.assertTrue(_eval_predicate(song, pred))

    def test_exact_max(self):
        song = {"year": 1990}
        pred = {"op": "year_between", "min": 1980, "max": 1990}
        self.assertTrue(_eval_predicate(song, pred))

    def test_missing_year_treated_as_zero(self):
        song = {}
        pred = {"op": "year_between", "min": 1980, "max": 1990}
        self.assertFalse(_eval_predicate(song, pred))

    def test_none_year_treated_as_zero(self):
        song = {"year": None}
        pred = {"op": "year_between", "min": 1980, "max": 1990}
        self.assertFalse(_eval_predicate(song, pred))


class TestYearIn(unittest.TestCase):
    def test_in_values(self):
        song = {"year": 1985}
        pred = {"op": "year_in", "values": [1980, 1985, 1990]}
        self.assertTrue(_eval_predicate(song, pred))

    def test_not_in_values(self):
        song = {"year": 1985}
        pred = {"op": "year_in", "values": [1980, 1990]}
        self.assertFalse(_eval_predicate(song, pred))

    def test_missing_year(self):
        song = {}
        pred = {"op": "year_in", "values": [1980, 1985]}
        self.assertFalse(_eval_predicate(song, pred))

    def test_empty_values(self):
        song = {"year": 1985}
        pred = {"op": "year_in", "values": []}
        self.assertFalse(_eval_predicate(song, pred))


class TestYearEndsWith(unittest.TestCase):
    def test_ends_with(self):
        song = {"year": 1985}
        pred = {"op": "year_ends_with", "digit": "5"}
        self.assertTrue(_eval_predicate(song, pred))

    def test_does_not_end_with(self):
        song = {"year": 1985}
        pred = {"op": "year_ends_with", "digit": "0"}
        self.assertFalse(_eval_predicate(song, pred))

    def test_missing_year(self):
        song = {}
        pred = {"op": "year_ends_with", "digit": "5"}
        self.assertFalse(_eval_predicate(song, pred))

    def test_none_year(self):
        song = {"year": None}
        pred = {"op": "year_ends_with", "digit": "5"}
        self.assertFalse(_eval_predicate(song, pred))


class TestFieldLenLte(unittest.TestCase):
    def test_within_limit(self):
        song = {"title": "Hello"}
        pred = {"op": "field_len_lte", "field": "title", "n": 10}
        self.assertTrue(_eval_predicate(song, pred))

    def test_at_limit(self):
        song = {"title": "Hello"}
        pred = {"op": "field_len_lte", "field": "title", "n": 5}
        self.assertTrue(_eval_predicate(song, pred))

    def test_above_limit(self):
        song = {"title": "Hello World"}
        pred = {"op": "field_len_lte", "field": "title", "n": 5}
        self.assertFalse(_eval_predicate(song, pred))

    def test_missing_field_treated_as_empty(self):
        song = {}
        pred = {"op": "field_len_lte", "field": "title", "n": 5}
        self.assertTrue(_eval_predicate(song, pred))


class TestFieldLenGte(unittest.TestCase):
    def test_above_min(self):
        song = {"title": "Hello World"}
        pred = {"op": "field_len_gte", "field": "title", "n": 5}
        self.assertTrue(_eval_predicate(song, pred))

    def test_at_min(self):
        song = {"title": "Hello"}
        pred = {"op": "field_len_gte", "field": "title", "n": 5}
        self.assertTrue(_eval_predicate(song, pred))

    def test_below_min(self):
        song = {"title": "Hi"}
        pred = {"op": "field_len_gte", "field": "title", "n": 5}
        self.assertFalse(_eval_predicate(song, pred))

    def test_missing_field_treated_as_empty(self):
        song = {}
        pred = {"op": "field_len_gte", "field": "title", "n": 5}
        self.assertFalse(_eval_predicate(song, pred))


class TestWordCount(unittest.TestCase):
    def test_exact_two_words(self):
        song = {"title": "Human Sadness"}
        pred = {"op": "word_count", "field": "title", "n": 2}
        self.assertTrue(_eval_predicate(song, pred))

    def test_one_word_fails(self):
        song = {"title": "Dare"}
        pred = {"op": "word_count", "field": "title", "n": 2}
        self.assertFalse(_eval_predicate(song, pred))

    def test_three_words_fails(self):
        song = {"title": "Death and Glitz"}
        pred = {"op": "word_count", "field": "title", "n": 2}
        self.assertFalse(_eval_predicate(song, pred))

    def test_collapses_extra_whitespace(self):
        song = {"title": "  Gone   With  "}
        pred = {"op": "word_count", "field": "title", "n": 2}
        self.assertTrue(_eval_predicate(song, pred))

    def test_missing_field_treated_as_empty(self):
        song = {}
        pred = {"op": "word_count", "field": "title", "n": 2}
        self.assertFalse(_eval_predicate(song, pred))

    def test_none_field_treated_as_empty(self):
        song = {"title": None}
        pred = {"op": "word_count", "field": "title", "n": 2}
        self.assertFalse(_eval_predicate(song, pred))


class TestFieldCase(unittest.TestCase):
    def test_upper_match(self):
        song = {"title": "HELLO"}
        pred = {"op": "field_case", "field": "title", "test": "upper"}
        self.assertTrue(_eval_predicate(song, pred))

    def test_upper_no_match(self):
        song = {"title": "Hello"}
        pred = {"op": "field_case", "field": "title", "test": "upper"}
        self.assertFalse(_eval_predicate(song, pred))

    def test_lower_match(self):
        song = {"title": "hello"}
        pred = {"op": "field_case", "field": "title", "test": "lower"}
        self.assertTrue(_eval_predicate(song, pred))

    def test_lower_no_match(self):
        song = {"title": "Hello"}
        pred = {"op": "field_case", "field": "title", "test": "lower"}
        self.assertFalse(_eval_predicate(song, pred))

    def test_missing_field(self):
        song = {}
        pred = {"op": "field_case", "field": "title", "test": "upper"}
        self.assertFalse(_eval_predicate(song, pred))


class TestFieldContainsField(unittest.TestCase):
    def test_contains(self):
        song = {"title": "Hello World", "artist": "World"}
        pred = {"op": "field_contains_field", "haystack": "title", "needle": "artist"}
        self.assertTrue(_eval_predicate(song, pred))

    def test_not_contains(self):
        song = {"title": "Hello World", "artist": "Mars"}
        pred = {"op": "field_contains_field", "haystack": "title", "needle": "artist"}
        self.assertFalse(_eval_predicate(song, pred))

    def test_case_insensitive(self):
        song = {"title": "HELLO WORLD", "artist": "world"}
        pred = {"op": "field_contains_field", "haystack": "title", "needle": "artist"}
        self.assertTrue(_eval_predicate(song, pred))

    def test_missing_haystack(self):
        song = {"artist": "World"}
        pred = {"op": "field_contains_field", "haystack": "title", "needle": "artist"}
        self.assertFalse(_eval_predicate(song, pred))


class TestFieldKeywords(unittest.TestCase):
    def test_single_keyword_found(self):
        song = {"tuning": "E Standard Drop D"}
        pred = {"op": "field_keywords", "field": "tuning", "words": ["drop", "standard"]}
        self.assertTrue(_eval_predicate(song, pred))

    def test_no_keyword_found(self):
        song = {"tuning": "E Standard"}
        pred = {"op": "field_keywords", "field": "tuning", "words": ["drop"]}
        self.assertFalse(_eval_predicate(song, pred))

    def test_case_insensitive(self):
        song = {"tuning": "E STANDARD"}
        pred = {"op": "field_keywords", "field": "tuning", "words": ["standard"]}
        self.assertTrue(_eval_predicate(song, pred))

    def test_missing_field(self):
        song = {}
        pred = {"op": "field_keywords", "field": "tuning", "words": ["drop"]}
        self.assertFalse(_eval_predicate(song, pred))


class TestSameFirstLetter(unittest.TestCase):
    def test_same_letter(self):
        song = {"artist": "Metallica", "album": "Master of Puppets"}
        pred = {"op": "same_first_letter", "fields": ["artist", "album"]}
        self.assertTrue(_eval_predicate(song, pred))

    def test_different_letter(self):
        song = {"artist": "Metallica", "album": "Ride the Lightning"}
        pred = {"op": "same_first_letter", "fields": ["artist", "album"]}
        self.assertFalse(_eval_predicate(song, pred))

    def test_first_field_empty(self):
        song = {"artist": "", "album": "Master of Puppets"}
        pred = {"op": "same_first_letter", "fields": ["artist", "album"]}
        self.assertFalse(_eval_predicate(song, pred))

    def test_second_field_empty(self):
        song = {"artist": "Metallica", "album": ""}
        pred = {"op": "same_first_letter", "fields": ["artist", "album"]}
        self.assertFalse(_eval_predicate(song, pred))

    def test_both_fields_missing(self):
        song = {}
        pred = {"op": "same_first_letter", "fields": ["artist", "album"]}
        self.assertFalse(_eval_predicate(song, pred))


class TestFieldAllDigits(unittest.TestCase):
    def test_all_digits(self):
        song = {"rating": "5"}
        pred = {"op": "field_all_digits", "field": "rating"}
        self.assertTrue(_eval_predicate(song, pred))

    def test_has_letters(self):
        song = {"rating": "5 stars"}
        pred = {"op": "field_all_digits", "field": "rating"}
        self.assertFalse(_eval_predicate(song, pred))

    def test_spaces_ignored(self):
        song = {"rating": "5 5"}
        pred = {"op": "field_all_digits", "field": "rating"}
        self.assertTrue(_eval_predicate(song, pred))

    def test_missing_field(self):
        song = {}
        pred = {"op": "field_all_digits", "field": "rating"}
        self.assertFalse(_eval_predicate(song, pred))


class TestFieldHasNonalnum(unittest.TestCase):
    def test_has_special_chars(self):
        song = {"title": "Hello!"}
        pred = {"op": "field_has_nonalnum", "field": "title"}
        self.assertTrue(_eval_predicate(song, pred))

    def test_only_alnum(self):
        song = {"title": "Hello"}
        pred = {"op": "field_has_nonalnum", "field": "title"}
        self.assertFalse(_eval_predicate(song, pred))

    def test_spaces_ignored(self):
        song = {"title": "Hello World"}
        pred = {"op": "field_has_nonalnum", "field": "title"}
        self.assertFalse(_eval_predicate(song, pred))

    def test_missing_field(self):
        song = {}
        pred = {"op": "field_has_nonalnum", "field": "title"}
        self.assertFalse(_eval_predicate(song, pred))


class TestUnknownOp(unittest.TestCase):
    def test_unknown_op_returns_false(self):
        song = {"title": "Hello"}
        pred = {"op": "unknown_op", "value": 123}
        self.assertFalse(_eval_predicate(song, pred))


if __name__ == "__main__":
    unittest.main()