// Insight's lists, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts).
import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("Insight", vocabulary, vocabulary.INSIGHT_VOCABULARIES)
