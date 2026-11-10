// The inspections vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts).
import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("inspections", vocabulary, vocabulary.INSPECTIONS_VOCABULARIES)
