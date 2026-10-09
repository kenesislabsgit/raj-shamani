import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from knowledge.caption_retrieval import retrieve, context_citation, source_citation, GUIDE_QUERY_PROMPT, GUIDE_RANK_PROMPT, ANSWER_RANK_PROMPT
from knowledge.supermemory_captions import caption_source


class RetrievalTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        directory = Path(temp.name)
        self.source = caption_source({'id': 'abcdefghijk', 'title': 'Memory'}, {'events': [
            {'tStartMs': i * 2000, 'dDurationMs': 2000, 'segs': [{'utf8': text}]}
            for i, text in enumerate(['Memory improves with recall practice.', 'This does not work for everyone.',
                                      'Consider your own schedule.'])]}, 'en')
        (directory / f"abcdefghijk-{self.source['revision'][:12]}.json").write_text(json.dumps(self.source))
        self.client, self.llm = Mock(), Mock()
        self.client.search.return_value = {'results': []}
        self.llm.complete.side_effect = [{'queries': ['memory recall practice']}, {'selected': [{'id': 'R0', 'reason': 'Memory practice'}]}]
        self.library = SimpleNamespace(directory=directory, llm=self.llm,
            client_factory=lambda: self.client, ready_videos=lambda: [{'id': 'abcdefghijk', 'revision': self.source['revision']}])

    def test_keyword_retrieval_recovers_evidence_when_remote_search_has_no_results(self):
        result = retrieve(self.library, 'Why do I forget what I learn?')
        self.assertEqual(result['retrieval']['queries'], ['Why do I forget what I learn?', 'memory recall practice'])
        self.assertTrue(result['excerpts'])
        cite = result['excerpts'][0]
        self.assertEqual(cite['quote'], ' '.join(s['text'] for s in self.source['segments']))
        self.assertEqual((cite['start'], cite['end']), (0, 6))
        self.assertTrue(cite['url'].endswith('&t=0s'))

    def test_search_progress_reports_queries_and_counts_without_captions(self):
        events = []
        retrieve(self.library, 'Why do I forget what I learn?', progress=events.append)
        self.assertEqual(events, [
            {'type': 'detail', 'phase': 'search', 'message': 'Searching for “memory recall practice”'},
            {'type': 'detail', 'phase': 'search', 'message': 'Found 1 candidate passage in 1 conversation'},
            {'type': 'detail', 'phase': 'search', 'message': 'Picked 1 passage to read closely'}])
        self.assertNotIn('recall practice.', json.dumps(events))

    def test_search_progress_reports_keyword_fallback(self):
        self.client.search.side_effect = RuntimeError('provider secret must not be logged')
        events = []
        retrieve(self.library, 'Explain memory', progress=events.append)
        messages = [event['message'] for event in events]
        self.assertIn('Semantic search was unavailable, so matched words in the captions instead', messages)
        self.assertNotIn('provider secret', json.dumps(events))

    def test_remote_outage_preserves_local_caption_retrieval(self):
        self.client.search.side_effect = RuntimeError('provider secret must not be logged')
        result = retrieve(self.library, 'Explain memory')
        self.assertTrue(result['excerpts'])
        self.assertEqual(result['retrieval']['remote_error'], 'RuntimeError')
        self.assertNotIn('provider secret', json.dumps(result))
        self.client.session.close.assert_called_once()

    def test_caption_files_are_read_as_utf8_on_windows(self):
        self.source['title'] = 'स्मृति और याददाश्त'
        path = self.library.directory / f"abcdefghijk-{self.source['revision'][:12]}.json"
        path.write_text(json.dumps(self.source, ensure_ascii=False), encoding='utf-8')
        result = retrieve(self.library, 'Explain memory')
        self.assertTrue(result['excerpts'])
        self.assertEqual(result['excerpts'][0]['title'], self.source['title'])

    def test_client_initialization_failure_preserves_local_search(self):
        self.library.client_factory = Mock(side_effect=RuntimeError('private client setup failure'))
        result = retrieve(self.library, 'Explain memory')
        self.assertTrue(result['excerpts'])
        self.assertEqual(result['retrieval']['remote_error'], 'RuntimeError')
        self.assertNotIn('private client setup', json.dumps(result))

    def test_reader_stops_at_empty_relevance_selection(self):
        self.library.answer_strategy = 'video_guide'
        self.library.allow_closest = False
        self.llm.complete.side_effect = [{'queries': ['memory']}, {'selected': []}]
        result = retrieve(self.library, 'Give me a cake recipe.')
        self.assertEqual(result['excerpts'], [])
        self.assertNotIn('closest_fallback', result['retrieval'])
        self.assertEqual(self.llm.complete.call_args.args[0], ANSWER_RANK_PROMPT)

    def test_reader_retains_useful_partial_evidence(self):
        self.library.answer_strategy = 'video_guide'
        self.library.allow_closest = False
        result = retrieve(self.library, 'Will recall practice guarantee my exam score?')
        self.assertTrue(result['excerpts'])

    def test_missing_archive_is_not_reported_as_an_irrelevant_question(self):
        self.library.ready_videos = lambda: [{'id': 'abcdefghijk', 'revision': 'missing'}]
        with self.assertRaisesRegex(ValueError, 'original captions.*unavailable'):
            retrieve(self.library, 'Explain memory')
        self.llm.complete.assert_called_once()
        self.client.search.assert_not_called()

    def test_guide_retrieval_accepts_useful_background_without_a_direct_answer(self):
        self.library.answer_strategy = 'video_guide'
        result = retrieve(self.library, 'Will recall practice guarantee my exam score?')
        self.assertTrue(result['excerpts'])
        self.assertEqual(self.llm.complete.call_args_list[0].args[0], GUIDE_QUERY_PROMPT)
        self.assertEqual(self.llm.complete.call_args_list[1].args[0], GUIDE_RANK_PROMPT)

    def test_guide_keeps_nearest_verified_candidates_when_ranker_finds_no_answer(self):
        self.library.answer_strategy = 'video_guide'
        self.llm.complete.side_effect = [{'queries': ['memory']}, {'selected': []}]
        result = retrieve(self.library, 'Give me a sourdough recipe.')
        self.assertTrue(result['excerpts'])
        self.assertIn('closest_fallback', result['retrieval'])
        self.assertEqual(result['excerpts'][0]['quote'], ' '.join(s['text'] for s in self.source['segments']))

    def test_guide_cannot_fabricate_a_closest_result_without_any_search_candidates(self):
        self.library.answer_strategy = 'video_guide'
        self.llm.complete.side_effect = [{'queries': []}]
        result = retrieve(self.library, 'sourdough bread')
        self.assertEqual(result['excerpts'], [])
        self.assertEqual(self.llm.complete.call_count, 1)

    def test_guide_does_not_ask_for_treatment_details(self):
        self.library.answer_strategy = 'video_guide'
        self.llm.complete.side_effect = [
            {'clarifying_question': 'Which medication should we use for the prescription?', 'queries': []},
            {'selected': [{'id': 'R0', 'reason': 'Related memory discussion'}]}]
        result = retrieve(self.library, 'Can memory practice replace medication?')
        self.assertNotIn('clarifying_question', result)
        self.assertIn('rejected_clarification', result['retrieval'])
        self.assertTrue(result['excerpts'])
        self.client.search.assert_called_once()

    def test_clear_topics_are_searched_despite_optional_planner_clarification(self):
        self.library.answer_strategy = 'video_guide'
        for question in ['can u tell me how ill become a billionaire at 22',
                         'how to tell to my boss my opinon on a matter of si ject']:
            with self.subTest(question=question):
                self.llm.complete.side_effect = [{'clarifying_question': 'Which specific field?', 'queries': []}]
                result = retrieve(self.library, question)
                self.assertNotIn('clarifying_question', result)
                self.assertEqual(result['retrieval']['queries'], [question])
                self.assertIn('rejected_clarification', result['retrieval'])

    def test_guide_still_clarifies_a_question_without_named_options(self):
        self.library.answer_strategy = 'video_guide'
        self.llm.complete.side_effect = [{'clarifying_question': 'Which options?', 'queries': []}]
        result = retrieve(self.library, 'Which one is better for me?')
        self.assertEqual(result['clarifying_question'], 'Which options?')
        self.client.search.assert_not_called()

    def test_missing_options_asks_clarification_before_searching(self):
        self.llm.complete.side_effect = [{'clarifying_question': 'Which options are you comparing?', 'queries': []}]
        result = retrieve(self.library, 'Which one is better for me?')
        self.assertEqual(result['clarifying_question'], 'Which options are you comparing?')
        self.assertEqual(result['excerpts'], [])
        self.client.search.assert_not_called()
        self.assertEqual(self.llm.complete.call_count, 1)

    def test_non_english_clarification_is_replaced_with_an_english_question(self):
        self.library.answer_strategy = 'video_guide'
        self.llm.complete.side_effect = [{'clarifying_question': 'कौन से विकल्प?', 'queries': []}]
        result = retrieve(self.library, 'कौन सा बेहतर है?')
        self.assertEqual(result['clarifying_question'], 'Which topic or options would you like help with?')
        self.assertEqual(self.llm.complete.call_args.args[1]['output_language'], 'English')
        self.client.search.assert_not_called()

    def test_context_expansion_preserves_negation_in_neighboring_caption(self):
        cite = context_citation(source_citation(self.source, 0, 0), self.source)
        self.assertIn('does not work for everyone', cite['quote'])
        self.assertEqual(cite['segment_ids'], ['C000000', 'C000001', 'C000002'])

    def test_scope_is_applied_to_every_remote_query(self):
        result = retrieve(self.library, 'memory', 'abcdefghijk')
        self.assertTrue(result['excerpts'])
        for call in self.client.search.call_args_list:
            self.assertEqual(call.kwargs['filters'], {'AND': [{'key': 'video_id', 'value': 'abcdefghijk'}]})
        with self.assertRaises(ValueError):
            retrieve(self.library, 'memory', 'outside0001')

    def test_unrelated_stale_and_altered_remote_hits_cannot_become_evidence(self):
        self.client.search.return_value = {'results': [
            {'metadata': {'video_id': 'outside0001', 'revision': self.source['revision']}, 'chunk': '[C000000] Fake'},
            {'metadata': {'video_id': 'abcdefghijk', 'revision': 'stale'}, 'chunk': '[C000000] Memory improves with recall practice.'},
            {'metadata': {'video_id': 'abcdefghijk', 'revision': self.source['revision']}, 'chunk': '[C000000] Altered claim'}]}
        self.llm.complete.side_effect = [{'queries': []}]
        result = retrieve(self.library, 'volcano spaceship')
        self.assertEqual(result['excerpts'], [])
        self.assertEqual(result['retrieval']['rejected_remote_hits'], 3)

    def test_unknown_reranker_id_cannot_create_evidence_and_empty_selection_abstains(self):
        self.llm.complete.side_effect = [{'queries': []}, {'selected': [{'id': 'R999'}]}]
        result = retrieve(self.library, 'memory')
        self.assertIn('selection_error', result['retrieval'])
        self.assertTrue(all(c['source_id'] == 'abcdefghijk' for c in result['excerpts']))
        self.llm.complete.side_effect = [{'queries': []}, {'selected': []}]
        self.assertEqual(retrieve(self.library, 'memory')['excerpts'], [])
